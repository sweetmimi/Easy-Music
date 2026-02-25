const { createApp, ref, computed, watch, nextTick, onMounted } = Vue;

// ===== IndexedDB helpers =====
const DB_NAME = 'easy-music-db';
const DB_VERSION = 1;
const STORE_SONGS = 'songs';
const STORE_LYRICS = 'lyrics';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_SONGS)) {
        db.createObjectStore(STORE_SONGS, { keyPath: 'baseName' });
      }
      if (!db.objectStoreNames.contains(STORE_LYRICS)) {
        db.createObjectStore(STORE_LYRICS, { keyPath: 'baseName' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

createApp({
  setup() {
    // Playback state
    const audioRef = ref(null);
    const isPlaying = ref(false);
    const currentTime = ref(0);
    const duration = ref(0);
    const currentIndex = ref(-1);
    const playMode = ref('sequential'); // 'sequential' | 'random'
    const fileInput = ref(null);
    const lyricsRef = ref(null);
    const playlistListRef = ref(null);
    const visualizerCanvas = ref(null);
    const folderSupported = ref('showDirectoryPicker' in window);

    // Web Audio for visualization
    let audioContext = null;
    let analyser = null;
    let animationFrameId = null;

    // Data
    const playlist = ref([]);
    const lyricsMap = ref({}); // { baseName: parsedLyrics }
    const shuffleOrder = ref([]); // Order for random play
    let lastStateSaveTime = 0;

    // Current song
    const currentSong = computed(() => {
      if (currentIndex.value < 0 || currentIndex.value >= playlist.value.length) return null;
      return playlist.value[currentIndex.value];
    });

    // Parsed lyrics for current song
    const lyricsLines = computed(() => {
      if (!currentSong.value) return [];
      const baseName = currentSong.value.baseName;
      return lyricsMap.value[baseName] || [];
    });

    // Current lyric index based on time
    const currentLyricIndex = computed(() => {
      const lines = lyricsLines.value;
      if (!lines.length) return -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (currentTime.value >= lines[i].time) return i;
      }
      return -1;
    });

    // Lyrics scroll offset (scroll active line to center)
    const lyricsOffset = computed(() => {
      const idx = currentLyricIndex.value;
      if (idx < 0) return 0;
      const lineHeight = 44;
      const containerHeight = 420;
      const centerOffset = containerHeight / 2 - lineHeight / 2;
      return centerOffset - idx * lineHeight;
    });

    // Progress
    const progressPercent = computed(() => {
      if (duration.value <= 0) return 0;
      return (currentTime.value / duration.value) * 100;
    });

    // LRC parser: [mm:ss.xx] or [mm:ss] text
    function parseLrc(text) {
      const result = [];
      const lines = text.trim().split('\n');

      for (const line of lines) {
        let m;
        const lineRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)/g;
        while ((m = lineRegex.exec(line)) !== null) {
          const mm = parseInt(m[1], 10);
          const ss = parseInt(m[2], 10);
          const xx = m[3] ? parseInt(String(m[3]).padEnd(3, '0').slice(0, 3), 10) : 0;
          result.push({
            time: mm * 60 + ss + xx / 1000,
            text: m[4].trim()
          });
        }
      }

      return result.sort((a, b) => a.time - b.time);
    }

    function formatTime(seconds) {
      if (!isFinite(seconds) || seconds < 0) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // Persist playback position to localStorage (lightweight)
    function savePlaybackState() {
      try {
        const state = {
          baseName: currentSong.value?.baseName || null,
          time: currentTime.value,
          playMode: playMode.value
        };
        localStorage.setItem('easy-music-state', JSON.stringify(state));
      } catch (e) { /* ignore */ }
    }

    function savePlaybackStateThrottled() {
      const now = Date.now();
      if (now - lastStateSaveTime < 1000) return;
      lastStateSaveTime = now;
      savePlaybackState();
    }

    // Persist audio files & lyrics to IndexedDB
    async function saveSongToDB(song) {
      try {
        const db = await openDB();
        await dbPut(db, STORE_SONGS, {
          baseName: song.baseName,
          name: song.name,
          blob: song.file
        });
        db.close();
      } catch (e) { /* ignore */ }
    }

    async function saveLyricsToDB(baseName, lrcLines) {
      try {
        const db = await openDB();
        await dbPut(db, STORE_LYRICS, { baseName, lines: lrcLines });
        db.close();
      } catch (e) { /* ignore */ }
    }

    // Restore everything from IndexedDB + localStorage on page load
    async function restoreFromDB() {
      try {
        const db = await openDB();
        const songs = await dbGetAll(db, STORE_SONGS);
        const lyrics = await dbGetAll(db, STORE_LYRICS);
        db.close();

        if (!songs.length) return;

        const restoredSongs = songs.map((s) => ({
          id: `${s.baseName}-${Date.now()}-${Math.random()}`,
          name: s.name,
          baseName: s.baseName,
          artist: '',
          file: s.blob,
          cover: null
        }));
        restoredSongs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        playlist.value = restoredSongs;

        const restoredLyrics = {};
        for (const l of lyrics) {
          restoredLyrics[l.baseName] = l.lines;
        }
        lyricsMap.value = restoredLyrics;

        shuffleOrder.value = getShuffleOrder();

        // Restore playback position from localStorage
        const raw = localStorage.getItem('easy-music-state');
        if (raw) {
          const last = JSON.parse(raw);
          if (last.playMode === 'random' || last.playMode === 'sequential') {
            playMode.value = last.playMode;
          }
          if (last.baseName) {
            const idx = playlist.value.findIndex((s) => s.baseName === last.baseName);
            if (idx >= 0) {
              playByIndex(idx);
              if (typeof last.time === 'number' && last.time > 0 && audioRef.value) {
                audioRef.value.addEventListener('loadedmetadata', () => {
                  audioRef.value.currentTime = last.time;
                  currentTime.value = last.time;
                  // Pause after seeking so user can manually resume
                  audioRef.value.pause();
                  isPlaying.value = false;
                  stopVisualizer();
                }, { once: true });
              }
            }
          }
        }
      } catch (e) {
        console.warn('Restore from DB failed:', e);
      }
    }

    // Read LRC file with auto encoding detection (UTF-8 / GBK for Chinese lyrics)
    async function readLrcFile(file) {
      const buffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      // Try UTF-8 first
      let str = new TextDecoder('utf-8').decode(uint8);
      if (!str.includes('\uFFFD')) return str;
      // Fallback to GBK (common for Chinese LRC from Windows/QQ音乐等)
      try {
        str = new TextDecoder('gbk').decode(uint8);
        return str;
      } catch {
        return new TextDecoder('utf-8').decode(uint8);
      }
    }

    function triggerFileInput() {
      fileInput.value?.click();
    }

    async function onFileSelect(e) {
      const files = Array.from(e.target.files || []);
      await processFiles(files);
      e.target.value = '';
    }

    function onDragOver(e) {
      e.currentTarget.classList.add('dragover');
    }

    function onDragLeave(e) {
      e.currentTarget.classList.remove('dragover');
    }

    async function onDrop(e) {
      e.currentTarget.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      await processFiles(files);
    }

    async function selectFolder() {
      if (!('showDirectoryPicker' in window)) {
        alert('您的浏览器不支持选择文件夹，请使用 Chrome 86+ 或 Edge 86+，或改用「选择文件」');
        return;
      }
      try {
        const dirHandle = await window.showDirectoryPicker();
        const files = await getAllAudioAndLrc(dirHandle);
        if (files.length) {
          await processFiles(files);
        } else {
          alert('该文件夹内未找到 MP3/M4A/OGG/WAV 或 LRC 文件');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          alert('选择文件夹失败：' + (err.message || err));
        }
      }
    }

    async function getAllAudioAndLrc(dirHandle) {
      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          const name = entry.name.toLowerCase();
          if (/\.(mp3|m4a|ogg|wav|lrc)$/.test(name)) {
            files.push(await entry.getFile());
          }
        } else if (entry.kind === 'directory') {
          const subFiles = await getAllAudioAndLrc(entry);
          files.push(...subFiles);
        }
      }
      return files;
    }

    async function processFiles(files) {
      const mp3Files = files.filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f.name));
      const lrcFiles = files.filter((f) => /\.lrc$/i.test(f.name));

      const lyricsByBase = {};
      for (const file of lrcFiles) {
        const baseName = file.name.replace(/\.lrc$/i, '');
        const text = await readLrcFile(file);
        lyricsByBase[baseName] = parseLrc(text);
      }

      const newSongs = mp3Files.map((file) => {
        const baseName = file.name.replace(/\.(mp3|m4a|ogg|wav)$/i, '');
        return {
          id: `${baseName}-${Date.now()}-${Math.random()}`,
          name: baseName,
          baseName,
          artist: '',
          file,
          cover: null
        };
      });

      if (newSongs.length) {
        // Dedupe: keep only one per filename (case-insensitive),
        // including duplicates within the same import batch
        const names = new Set(playlist.value.map((s) => s.baseName.toLowerCase()));
        const toAdd = [];
        for (const song of newSongs) {
          const key = song.baseName.toLowerCase();
          if (names.has(key)) continue;
          names.add(key);
          toAdd.push(song);
        }

        const playingId = currentSong.value?.id;

        if (toAdd.length) {
          toAdd.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          playlist.value.push(...toAdd);
          playlist.value.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

          // Save new songs to IndexedDB
          for (const song of toAdd) {
            saveSongToDB(song);
          }
        }

        Object.assign(lyricsMap.value, lyricsByBase);
        for (const [baseName, lines] of Object.entries(lyricsByBase)) {
          saveLyricsToDB(baseName, lines);
        }

        if (currentIndex.value < 0 && playlist.value.length) {
          currentIndex.value = 0;
          playByIndex(0);
        } else if (playingId !== undefined && toAdd.length) {
          const newIdx = playlist.value.findIndex((s) => s.id === playingId);
          if (newIdx >= 0) currentIndex.value = newIdx;
        }

        shuffleOrder.value = getShuffleOrder();
        savePlaybackState();
      }
    }

    function getShuffleOrder() {
      const arr = Array.from({ length: playlist.value.length }, (_, i) => i);
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function togglePlayMode() {
      playMode.value = playMode.value === 'sequential' ? 'random' : 'sequential';
      shuffleOrder.value = getShuffleOrder();
    }

    function getNextIndex() {
      if (playlist.value.length === 0) return -1;
      if (playMode.value === 'sequential') {
        return (currentIndex.value + 1) % playlist.value.length;
      }
      const idxInShuffle = shuffleOrder.value.indexOf(currentIndex.value);
      const nextIdxInShuffle = (idxInShuffle + 1) % shuffleOrder.value.length;
      return shuffleOrder.value[nextIdxInShuffle];
    }

    function getPrevIndex() {
      if (playlist.value.length === 0) return -1;
      if (playMode.value === 'sequential') {
        return currentIndex.value <= 0
          ? playlist.value.length - 1
          : currentIndex.value - 1;
      }
      const idxInShuffle = shuffleOrder.value.indexOf(currentIndex.value);
      const prevIdxInShuffle = idxInShuffle <= 0
        ? shuffleOrder.value.length - 1
        : idxInShuffle - 1;
      return shuffleOrder.value[prevIdxInShuffle];
    }

    function initAudioVisualizer(audio) {
      try {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();

        const source = audioContext.createMediaElementSource(audio);
        if (analyser) analyser.disconnect();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        analyser.connect(audioContext.destination);

        startVisualizer();
      } catch (e) {
        console.warn('Audio visualizer init failed:', e);
      }
    }

    function stopVisualizer() {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
      const bgCanvas = document.getElementById('bg-canvas');
      if (bgCanvas) {
        const ctx = bgCanvas.getContext('2d');
        ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      }
    }

    function startVisualizer() {
      stopVisualizer();
      const barCanvas = visualizerCanvas.value;
      const bgCanvas = document.getElementById('bg-canvas');
      if (!analyser) return;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function draw() {
        animationFrameId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const intensity = Math.min(1, avg / 100);

        // Background canvas - full screen reactive glow
        if (bgCanvas) {
          bgCanvas.width = window.innerWidth;
          bgCanvas.height = window.innerHeight;
          const bgCtx = bgCanvas.getContext('2d');
          bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
          const gr = bgCtx.createRadialGradient(
            bgCanvas.width / 2, bgCanvas.height * 0.3, 0,
            bgCanvas.width / 2, bgCanvas.height * 0.5, bgCanvas.width * 0.8
          );
          gr.addColorStop(0, `rgba(29, 185, 84, ${0.08 + intensity * 0.12})`);
          gr.addColorStop(0.5, `rgba(29, 185, 84, ${0.03 + intensity * 0.06})`);
          gr.addColorStop(1, 'rgba(29, 185, 84, 0)');
          bgCtx.fillStyle = gr;
          bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
        }

        // Bar visualizer in player area
        if (barCanvas) {
          barCanvas.width = barCanvas.offsetWidth;
          barCanvas.height = barCanvas.offsetHeight;
          const ctx = barCanvas.getContext('2d');
          ctx.clearRect(0, 0, barCanvas.width, barCanvas.height);

          const barCount = 24;
          const barWidth = Math.min(5, (barCanvas.width - 40) / barCount - 2);
          const gap = 2;
          const startX = (barCanvas.width - (barCount * (barWidth + gap) - gap)) / 2;
          const baseHeight = 4;
          const maxHeight = 48;

          for (let i = 0; i < barCount; i++) {
            const idx = Math.floor((i / barCount) * dataArray.length);
            const v = dataArray[idx] / 255;
            const h = baseHeight + v * maxHeight;
            const x = startX + i * (barWidth + gap);
            const y = barCanvas.height - 20 - h;
            const gradient = ctx.createLinearGradient(x, y, x, barCanvas.height);
            gradient.addColorStop(0, `rgba(29, 185, 84, ${0.6 + intensity * 0.4})`);
            gradient.addColorStop(1, 'rgba(29, 185, 84, 0.15)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(x, y, barWidth, h, 2);
            } else {
              ctx.rect(x, y, barWidth, h);
            }
            ctx.fill();
          }
        }
      }

      draw();
    }

    function playByIndex(index) {
      if (index < 0 || index >= playlist.value.length) return;
      currentIndex.value = index;
      const song = playlist.value[index];
      const url = URL.createObjectURL(song.file);

      if (audioRef.value) {
        audioRef.value.pause();
        stopVisualizer();
        URL.revokeObjectURL(audioRef.value.src);
      }

      const audio = new Audio(url);
      audioRef.value = audio;

      audio.addEventListener('loadedmetadata', () => {
        duration.value = audio.duration;
      });
      audio.addEventListener('timeupdate', () => {
        currentTime.value = audio.currentTime;
        savePlaybackStateThrottled();
      });
      audio.addEventListener('ended', () => {
        next();
      });
      audio.addEventListener('play', () => {
        initAudioVisualizer(audio);
      });

      audio.play();
      isPlaying.value = true;
    }

    function togglePlay() {
      if (!audioRef.value) {
        if (playlist.value.length) playByIndex(currentIndex.value < 0 ? 0 : currentIndex.value);
        return;
      }
      if (isPlaying.value) {
        audioRef.value.pause();
        stopVisualizer();
      } else {
        audioRef.value.play();
        if (analyser) startVisualizer();
      }
      isPlaying.value = !isPlaying.value;
    }

    function next() {
      const nextIdx = getNextIndex();
      if (nextIdx >= 0) playByIndex(nextIdx);
    }

    function prev() {
      if (currentTime.value > 3 && audioRef.value) {
        audioRef.value.currentTime = 0;
        currentTime.value = 0;
        return;
      }
      const prevIdx = getPrevIndex();
      if (prevIdx >= 0) playByIndex(prevIdx);
    }

    function seekTo(e) {
      if (!audioRef.value) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const percent = (e.clientX - rect.left) / rect.width;
      const time = percent * duration.value;
      audioRef.value.currentTime = time;
      currentTime.value = time;
    }

    // Restore playlist and playback on page load
    onMounted(() => {
      restoreFromDB();
    });

    // Scroll playlist to current item when currentIndex changes
    watch(currentIndex, () => {
      nextTick(() => {
        const list = playlistListRef.value;
        const active = list?.querySelector('li.active');
        if (active) {
          active.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    });

    // Keep audio ref in DOM for Vue reactivity - use a hidden audio
    return {
      fileInput,
      lyricsRef,
      playlistListRef,
      visualizerCanvas,
      folderSupported,
      isPlaying,
      currentTime,
      duration,
      currentIndex,
      playMode,
      playlist,
      currentSong,
      lyricsLines,
      currentLyricIndex,
      lyricsOffset,
      progressPercent,
      triggerFileInput,
      onFileSelect,
      onDragOver,
      onDragLeave,
      onDrop,
      selectFolder,
      togglePlay,
      next,
      prev,
      togglePlayMode,
      playByIndex,
      seekTo,
      formatTime
    };
  }
}).mount('#app');
