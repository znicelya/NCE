(() => {
    document.addEventListener('DOMContentLoaded', () => {

        /** 正则常量 */
        const LINE_RE = /\[(\d+:\d+\.\d+)\](.*)/;
        const TIME_RE = /\[(\d+):(\d+(?:\.\d+)?)\]/;
        const INFO_RE = {
            album: /\[al:(.*)\]/,
            artist: /\[ar:(.*)\]/,
            title: /\[ti:(.*)\]/
        };

        const utils = window.NCEUtils;
        if (!utils) {
            console.error('NCEUtils is not available.');
            return;
        }

        const {
            createPlaceholderCover,
            deriveLrcUrl,
            parseCustomBookKey,
            loadStoredCustomData,
            prepareCustomLessons,
            openShare,
            detectShareEnvironment
        } = utils;

        /** 读取 URL hash 并构造资源路径 */
        const hashSegment = location.hash.slice(1).split('?')[0];
        if (!hashSegment) {
            window.location.href = 'book.html';
            return;
        }

        const hashParts = hashSegment.split('/');
        const bookToken = hashParts[0] || '';
        const isCustomLesson = bookToken === 'CUSTOM';
        let customLessonsMap = {};

        function refreshCustomLessonsMap() {
            customLessonsMap = prepareCustomLessons(loadStoredCustomData(), { deriveLrc: true });
        }

        refreshCustomLessonsMap();

        let bookScr = '';
        let bookImgSrc = '';
        let mp3Src = '';
        let lrcSrc = '';
        let fallbackAlbum = '';
        let fallbackTitle = '';
        let defaultBookToken = bookToken;
        let defaultBookNumber = null;
        let lessonSlug = '';
        let customBookName = '';
        let customLessonIndex = -1;
        let currentLessonMeta = null;
        let customBookDisplayName = '';
        let customBookCover = '';

        if (isCustomLesson) {
            customBookName = decodeURIComponent(hashParts[1] || '');
            customLessonIndex = parseInt(hashParts[2], 10);
            const lessons = Array.isArray(customLessonsMap[customBookName]) ? customLessonsMap[customBookName] : [];
            currentLessonMeta = lessons[customLessonIndex];
            if (!customBookName || Number.isNaN(customLessonIndex) || !currentLessonMeta) {
                window.location.href = 'book.html';
                return;
            }
            mp3Src = currentLessonMeta.filename;
            lrcSrc = currentLessonMeta.lrc || deriveLrcUrl(mp3Src);
            const parsedBook = parseCustomBookKey(customBookName);
            customBookDisplayName = parsedBook.name;
            customBookCover = parsedBook.cover;
            bookScr = `book.html#CUSTOM/${encodeURIComponent(customBookName)}`;
            bookImgSrc = customBookCover || createPlaceholderCover(customBookDisplayName);
            fallbackAlbum = customBookDisplayName;
            fallbackTitle = currentLessonMeta.title || '';
        } else {
            defaultBookToken = bookToken || 'NCE1';
            defaultBookNumber = parseInt(defaultBookToken.replace('NCE', ''), 10);
            lessonSlug = hashParts[1] ? decodeURIComponent(hashParts[1]) : '';
            if (!defaultBookNumber || !lessonSlug) {
                window.location.href = 'book.html';
                return;
            }
            mp3Src = `${defaultBookToken}/${lessonSlug}.mp3`;
            lrcSrc = `${defaultBookToken}/${lessonSlug}.lrc`;
            bookScr = `book.html#${defaultBookToken}`;
            bookImgSrc = `images/${defaultBookToken}.jpg`;
            fallbackAlbum = '';
            fallbackTitle = lessonSlug;
        }


        /** DOM 引用 */
        const audio = document.getElementById('player');
        const content = document.getElementById('content');
        const bookEl = document.getElementById('book');
        const bookTitleEl = document.getElementById('book-title');
        const bookImgEl = document.getElementById('book-img');
        const lessonTitleEl = document.getElementById('lesson-title');
        const modesContainer = document.getElementById('playback-modes');
        const setAButton = document.getElementById('set-a');
        const setBButton = document.getElementById('set-b');
        const speedContainer = document.getElementById('playback-speed');
        const customSpeedButton = document.getElementById('speed-3x');
        const dictationModeCheckbox = document.getElementById('dictation-mode');
        const dictationContainer = document.getElementById('dictation-container');
        const shareContainer = document.getElementById('share-container');
        const shareTrigger = document.getElementById('share-trigger');
        const shareMenu = document.getElementById('share-menu');
        const shareFeedback = document.getElementById('share-feedback');
        const wechatPopover = document.getElementById('wechat-share-popover');
        const wechatQrImage = document.getElementById('wechat-share-qr');
        const wechatCloseBtn = document.getElementById('wechat-share-close');
        const hasNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
        const shareEnvironment = detectShareEnvironment ? detectShareEnvironment() : { isMobile: false, isWeChatBrowser: false };

        // Custom player controls
        const playPauseBtn = document.getElementById('play-pause-btn');
        const progressBar = document.getElementById('progress-bar');
        const progress = document.getElementById('progress');
        const timeDisplay = document.getElementById('time-display');
        const volumeBtn = document.getElementById('volume-btn');
        const volumeSlider = document.getElementById('volume-slider');
        let isDraggingProgress = false;
        let wasPlayingBeforeDrag = false;
        let pendingSeekTime = null;

        /** 数据结构 */
        const state = {
            data: [],          // [{en, cn, start, end}]
            album: fallbackAlbum,
            artist: '',
            title: fallbackTitle,
            segmentEnd: 0,
            activeIdx: -1,
            playbackMode: 'single-play', // 'single-play', 'single-loop', 'continuous', 'ab-loop'
            dictation: false,
            abLoop: { a: null, b: null },
            hasTranslation: false
        };
        audio.preload = 'auto';
        audio.src = mp3Src;
        audio.load();
        bookImgEl.src = bookImgSrc;
        bookImgEl.alt = isCustomLesson ? (customBookDisplayName || customBookName) : defaultBookToken;
        
        // Disable content interaction until audio is ready
        content.style.pointerEvents = 'none';
        content.style.opacity = '0.5';
        
        // Monitor audio loading and state changes
        let stalledCount = 0;
        let lastStalledTime = 0;
        
        function enableAudioUi() {
            content.style.pointerEvents = '';
            content.style.opacity = '';
        }

        function markAudioReady(reason) {
            if (audio.error || audio.readyState < 1) {
                return;
            }
            if (!audioReady) {
                console.log('[AUDIO] Marking audio ready via', reason, '- readyState:', audio.readyState);
            }
            audioReady = true;
            enableAudioUi();
        }

        audio.addEventListener('loadstart', () => console.log('[AUDIO] loadstart - readyState:', audio.readyState));
        audio.addEventListener('loadedmetadata', () => {
            console.log('[AUDIO] loadedmetadata - readyState:', audio.readyState, 'duration:', audio.duration);
            markAudioReady('loadedmetadata');
        });
        audio.addEventListener('loadeddata', () => {
            console.log('[AUDIO] loadeddata - readyState:', audio.readyState);
            markAudioReady('loadeddata');
        });
        let audioReady = false;
        audio.addEventListener('canplay', () => {
            console.log('[AUDIO] canplay - readyState:', audio.readyState);
            stalledCount = 0; // Reset stalled counter on successful load
            markAudioReady('canplay');
        });
        audio.addEventListener('canplaythrough', () => console.log('[AUDIO] canplaythrough - readyState:', audio.readyState));
        audio.addEventListener('stalled', () => {
            const now = Date.now();
            stalledCount++;
            console.warn('[AUDIO] stalled - readyState:', audio.readyState, 'count:', stalledCount);
            
            // If stalled multiple times in short period, force reload
            if (stalledCount >= 2 && now - lastStalledTime < 5000) {
                console.error('[AUDIO] Multiple stalls detected, forcing reload');
                const currentTime = audio.currentTime;
                const wasPaused = audio.paused;
                audio.load();
                // Restore position after load
                audio.addEventListener('loadedmetadata', function restorePosition() {
                    audio.removeEventListener('loadedmetadata', restorePosition);
                    audio.currentTime = currentTime;
                    if (!wasPaused) {
                        audio.play().catch(e => console.error('[AUDIO] Play after reload failed:', e));
                    }
                }, { once: true });
                stalledCount = 0;
            }
            lastStalledTime = now;
        });
        audio.addEventListener('suspend', () => {
            console.warn('[AUDIO] suspend - readyState:', audio.readyState);
            markAudioReady('suspend');
        });
        audio.addEventListener('error', (e) => console.error('[AUDIO] Error loading:', audio.error, 'readyState:', audio.readyState));

        const displayModesContainer = document.getElementById('display-modes');
        const DISPLAY_MODE_EVENT = 'nce:displayModeAvailability';

        /** ------------------------------------------------- 
         *  Utilities
         * ------------------------------------------------- */
        function formatTime(seconds) {
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
        }

        function findSentenceIndexAtTime(time) {
            if (!Array.isArray(state.data) || !state.data.length) {
                return -1;
            }
            return state.data.findIndex(
                item => time >= item.start && (time < item.end || !item.end)
            );
        }

        function updateHighlightForTime(time, options = {}) {
            const { updateSegmentEnd = false } = options;
            const idx = findSentenceIndexAtTime(time);
            if (idx === -1) {
                // If no sentence found at this time, clear segmentEnd to prevent loop-back
                state.segmentEnd = 0;
                return;
            }
            highlight(idx, options);
            // Only update segmentEnd if explicitly requested
            // This prevents manual seeks from being overridden by playback logic
            if (updateSegmentEnd) {
                const sentence = state.data[idx];
                if (sentence) {
                    state.segmentEnd = sentence.end;
                }
            }
        }

        function updateSeekFromClientX(clientX) {
            const duration = audio.duration;
            if (!duration || Number.isNaN(duration)) {
                return null;
            }
            const rect = progressBar.getBoundingClientRect();
            const width = rect.width;
            if (!width) {
                return null;
            }
            let offsetX = clientX - rect.left;
            offsetX = Math.min(Math.max(offsetX, 0), width);
            const ratio = offsetX / width;
            const targetTime = ratio * duration;
            progress.style.width = `${ratio * 100}%`;
            timeDisplay.textContent = `${formatTime(targetTime)} / ${formatTime(duration)}`;
            return targetTime;
        }

        /** -------------------------------------------------
         *  分享功能
         * ------------------------------------------------- */
        let shareFeedbackTimer = null;

        function closeShareMenu() {
            if (!shareMenu || !shareTrigger) return;
            shareMenu.classList.remove('open');
            shareMenu.setAttribute('aria-hidden', 'true');
            shareTrigger.setAttribute('aria-expanded', 'false');
            shareTrigger.classList.remove('is-open');
        }

        function openShareMenu() {
            if (!shareMenu || !shareTrigger) return;
            hideWeChatPopover();
            if (shareFeedback) {
                shareFeedback.classList.remove('visible');
                shareFeedback.setAttribute('aria-hidden', 'true');
            }
            if (shareFeedbackTimer) {
                clearTimeout(shareFeedbackTimer);
                shareFeedbackTimer = null;
            }
            shareMenu.classList.add('open');
            shareMenu.setAttribute('aria-hidden', 'false');
            shareTrigger.setAttribute('aria-expanded', 'true');
            shareTrigger.classList.add('is-open');
        }

        function hideWeChatPopover() {
            if (!wechatPopover) return;
            wechatPopover.classList.remove('visible');
            wechatPopover.setAttribute('aria-hidden', 'true');
            if (wechatQrImage) {
                wechatQrImage.removeAttribute('src');
            }
        }

        function showWeChatPopover(payload) {
            if (!wechatPopover || !wechatQrImage) {
                showShareFeedback('浏览器限制，复制链接分享给好友吧');
                return;
            }
            if (!payload || !payload.qrImage) {
                showShareFeedback('二维码生成失败，稍后再试或改用其它方式');
                return;
            }
            wechatQrImage.src = payload.qrImage;
            wechatPopover.classList.add('visible');
            wechatPopover.setAttribute('aria-hidden', 'false');
        }

        function handleWeChatInternalShare(options) {
            const messages = [];
            if (shareEnvironment.isWeChatBrowser) {
                messages.push('请点击右上角菜单，选择“分享到朋友圈”或“发送给朋友”。');
            }
            if (!messages.length) {
                messages.push('请使用系统分享或复制链接转发给好友。');
            }
            showShareFeedback(messages.join(' '));
        }

        function showShareFeedback(message) {
            if (!shareFeedback || !message) {
                return;
            }
            hideWeChatPopover();
            shareFeedback.textContent = message;
            shareFeedback.classList.add('visible');
            shareFeedback.setAttribute('aria-hidden', 'false');
            if (shareFeedbackTimer) {
                clearTimeout(shareFeedbackTimer);
            }
            shareFeedbackTimer = setTimeout(() => {
                shareFeedback.classList.remove('visible');
                shareFeedback.setAttribute('aria-hidden', 'true');
                shareFeedbackTimer = null;
            }, 2800);
        }

        function getShareOptions() {
            const currentUrl = window.location.href;
            const lessonTitle = (lessonTitleEl ? lessonTitleEl.textContent : '') || state.title || fallbackTitle || document.title || '';
            const albumTitle = (bookTitleEl ? bookTitleEl.textContent : '') || state.album || fallbackAlbum || '';
            const cleanLesson = lessonTitle.trim() || '精选课程';
            const cleanAlbum = albumTitle.trim();
            const headline = cleanAlbum ? `《${cleanLesson}》 · ${cleanAlbum}` : `《${cleanLesson}》`;
            const benefitLine = '逐句精听 · 中英双显 · 听写训练';
            const invitation = cleanAlbum
                ? `我正在新概念英语中精读${headline}，一起来打卡进步吧！`
                : `我正在新概念英语中精读${headline}，一起坚持英语打卡吧！`;
            return {
                url: currentUrl,
                title: `${headline} | 新概念英语精读`,
                description: `${benefitLine}`,
                text: `${invitation}`,
                image: bookImgEl ? bookImgEl.src : ''
            };
        }

        function handleShare(target) {
            if (!openShare || !target) {
                return;
            }
            if (target === 'native' && !hasNativeShare) {
                showShareFeedback('当前浏览器不支持系统分享，试试复制链接吧');
                return;
            }
            const payload = openShare(target, {
                ...getShareOptions(),
                windowFeatures: 'width=680,height=580,top=88,left=120,toolbar=no,menubar=no,scrollbars=yes,resizable=yes'
            });
            if (!payload) {
                showShareFeedback('分享未完成，稍后再试或换个渠道吧');
                return;
            }
            switch (payload.mode) {
                case 'qr':
                    showWeChatPopover(payload);
                    break;
                case 'wechat-internal':
                    handleWeChatInternalShare(payload);
                    break;
                case 'copy':
                    showShareFeedback('链接已复制，快去邀请好友一起学习吧！');
                    break;
                case 'native':
                    showShareFeedback('已唤起系统分享，挑选好友一起打卡！');
                    break;
                default:
                    showShareFeedback('分享窗口已打开，邀好友共同进步！');
                    break;
            }
        }

        if (shareMenu && !hasNativeShare) {
            const nativeButtons = shareMenu.querySelectorAll('[data-requires-native="true"]');
            nativeButtons.forEach((btn) => btn.remove());
        }

        if (shareMenu && shareEnvironment.isMobile) {
            const weChatItem = shareMenu.querySelector('[data-share-target="wechat"] span:last-child');
            if (weChatItem) {
                weChatItem.textContent = shareEnvironment.isWeChatBrowser ? '微信内转发指南' : '微信好友速分享';
            }
        }

        if (shareTrigger) {
            shareTrigger.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (shareMenu && shareMenu.classList.contains('open')) {
                    closeShareMenu();
                } else {
                    openShareMenu();
                }
            });
        }

        if (shareMenu) {
            shareMenu.addEventListener('click', (event) => {
                const targetBtn = event.target.closest('[data-share-target]');
                if (!targetBtn) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                closeShareMenu();
                handleShare(targetBtn.dataset.shareTarget);
            });
        }

        if (shareContainer) {
            shareContainer.addEventListener('click', (event) => {
                event.stopPropagation();
            });
        }

        document.addEventListener('click', () => {
            closeShareMenu();
            hideWeChatPopover();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeShareMenu();
                hideWeChatPopover();
            }
        });

        if (wechatCloseBtn) {
            wechatCloseBtn.addEventListener('click', (event) => {
                event.preventDefault();
                hideWeChatPopover();
            });
        }

        if (wechatPopover) {
            wechatPopover.addEventListener('click', (event) => {
                event.stopPropagation();
            });
        }

        /** ------------------------------------------------- 
         *  元信息解析
         * ------------------------------------------------- */
        function parseInfo(line) {
            for (const key in INFO_RE) {
                const m = line.match(INFO_RE[key]);
                if (m) state[key] = m[1];
            }
        }

        /** ------------------------------------------------- 
         *  时间解析
         * ------------------------------------------------- */
        function parseTime(tag) {
            const m = TIME_RE.exec(tag);
            return m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) -0.5 : 0;
        }

        /** ------------------------------------------------- 
         *  LRC 解析
         * ------------------------------------------------- */
        async function loadLrc() {
            state.data = [];
            state.hasTranslation = false;
            try {
                const lrcRes = await fetch(lrcSrc);
                if (!lrcRes.ok) {
                    throw new Error(`Failed to load LRC: ${lrcRes.status}`);
                }
                
                // Read as ArrayBuffer to handle different encodings
                const buffer = await lrcRes.arrayBuffer();
                let text = '';
                
                // Try to decode with different encodings
                // Order matters: try most common encodings first
                const encodings = [
                    'utf-8',
                    'gbk',           // Simplified Chinese
                    'gb2312',        // Simplified Chinese (older)
                    'big5',          // Traditional Chinese
                    'windows-1252',  // Western European (ANSI)
                    'windows-1250',  // Central European (ANSI)
                    'iso-8859-1',    // Latin-1
                    'iso-8859-2',    // Latin-2 (Central European)
                    'shift-jis',     // Japanese
                    'euc-jp',        // Japanese
                    'euc-kr',        // Korean
                    'windows-1251'   // Cyrillic
                ];
                let decoded = false;
                let bestText = '';
                let bestScore = -1;
                
                for (const encoding of encodings) {
                    try {
                        const decoder = new TextDecoder(encoding, { fatal: true });
                        const decodedText = decoder.decode(buffer);
                        
                        // Check if the decoded text contains valid LRC format
                        if (!decodedText.includes('[') || !/\d+:\d+/.test(decodedText)) {
                            continue;
                        }
                        
                        // Score the decoded text quality
                        // Higher score = better decoding
                        let score = 0;
                        
                        // Penalty for replacement characters (�)
                        const replacementChars = (decodedText.match(/�/g) || []).length;
                        score -= replacementChars * 100;
                        
                        // Penalty for invalid Unicode sequences
                        const invalidChars = (decodedText.match(/[\uFFFD\uFFFE\uFFFF]/g) || []).length;
                        score -= invalidChars * 100;
                        
                        // Bonus for valid CJK characters (Chinese, Japanese, Korean)
                        const cjkChars = (decodedText.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
                        score += cjkChars * 2;
                        
                        // Bonus for valid ASCII printable characters
                        const asciiChars = (decodedText.match(/[\x20-\x7E]/g) || []).length;
                        score += asciiChars * 0.5;
                        
                        // If this is the best decoding so far, save it
                        if (score > bestScore) {
                            bestScore = score;
                            bestText = decodedText;
                            decoded = true;
                        }
                        
                        // If we have a perfect score (no replacement chars), use it immediately
                        if (replacementChars === 0 && invalidChars === 0 && score > 0) {
                            text = decodedText;
                            decoded = true;
                            break;
                        }
                    } catch (e) {
                        // Decoding failed with this encoding, try next
                        continue;
                    }
                }
                
                // Use the best decoded text if we found one
                if (decoded && bestText) {
                    text = bestText;
                } else {
                    // Fallback to UTF-8 if no encoding worked
                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    text = decoder.decode(buffer);
                }
                
                const lines = text.split(/\r?\n/).filter(Boolean);

                lines.forEach((raw, i) => {
                    const line = raw.trim();
                    const match = line.match(LINE_RE);

                    if (!match) {
                        parseInfo(line);
                        return;
                    }

                    const start = parseTime(`[${match[1]}]`);
                    const contentAfterTimestamp = match[2] || '';
                    const [enRaw, cnRaw = ''] = contentAfterTimestamp.split('|');
                    const en = (enRaw || '').trim();
                    const cn = (cnRaw || '').trim();
                    
                    // Skip empty lines (lines with only timestamp but no text, or only whitespace)
                    if (!en && !cn) {
                        return;
                    }
                    
                    if (cn) {
                        state.hasTranslation = true;
                    }

                    let end = 0;
                    for (let j = i + 1; j < lines.length; j++) {
                        const nxt = lines[j].match(LINE_RE);
                        if (nxt) {
                            end = parseTime(`[${nxt[1]}]`);
                            break;
                        }
                    }
                    state.data.push({en, cn, start, end});
                });
            } catch (error) {
                console.error('Failed to load LRC:', error);
            }
            render();
            updateDisplayModeAvailability();
        }

        function updateDisplayModeAvailability() {
            if (displayModesContainer) {
                displayModesContainer.dataset.available = state.hasTranslation ? '1' : '0';
                if (state.hasTranslation) {
                    displayModesContainer.style.display = '';
                } else {
                    displayModesContainer.style.display = 'none';
                    content.classList.remove('bilingual-mode', 'cn-mode');
                    content.classList.add('en-mode');
                    try {
                        localStorage.setItem('displayMode', 'en-mode');
                    } catch (_) {
                        /* noop */
                    }
                }
            }
            document.dispatchEvent(new CustomEvent(DISPLAY_MODE_EVENT, {
                detail: { hasTranslation: state.hasTranslation }
            }));
        }


        /** ------------------------------------------------- 
         *  渲染
         * ------------------------------------------------- */
        function render() {
            bookEl.href = bookScr;
            const albumDisplay = state.album || fallbackAlbum;
            const titleDisplay = state.title || fallbackTitle;
            bookTitleEl.textContent = albumDisplay;
            lessonTitleEl.textContent = titleDisplay;

            content.innerHTML = state.data.map(
                (item, idx) =>
                    `<div class="sentence" data-idx="${idx}">
                    <div class="en">${item.en}</div>
                    <div class="cn">${item.cn}</div>
                </div>`
            ).join('');
        }

        /** ------------------------------------------------- 
         *  播放区间
         * ------------------------------------------------- */
        let pendingPlayRequest = null;
        let lastSeekTime = 0;
        const SEEK_DEBOUNCE_MS = 300; // 防抖间隔：300ms内的重复seek会被忽略（避免服务器过载）
        
        function playSegment(start, end) {
            if (!audioReady && !audio.error) {
                console.warn('[PLAY] Audio not marked ready yet, attempting playback anyway');
                if (audio.networkState === audio.NETWORK_IDLE || audio.readyState === 0) {
                    audio.load();
                }
            }
            
            const now = Date.now();
            // 防抖：如果距离上次seek太近，先记录位置但延迟执行
            if (now - lastSeekTime < SEEK_DEBOUNCE_MS) {
                console.log('[PLAY] Seek too fast, debouncing...');
                // 取消之前的延迟执行
                if (pendingPlayRequest && pendingPlayRequest.debounceTimeout) {
                    clearTimeout(pendingPlayRequest.debounceTimeout);
                }
                // 延迟执行
                const debounceTimeout = setTimeout(() => {
                    lastSeekTime = Date.now();
                    executePlaySegment(start, end);
                }, SEEK_DEBOUNCE_MS);
                
                if (pendingPlayRequest) {
                    pendingPlayRequest.debounceTimeout = debounceTimeout;
                } else {
                    pendingPlayRequest = { debounceTimeout };
                }
                return;
            }
            
            lastSeekTime = now;
            executePlaySegment(start, end);
        }
        
        function executePlaySegment(start, end) {
            console.log('[PLAY] playSegment called - start:', start, 'readyState:', audio.readyState, 'networkState:', audio.networkState);
            state.segmentEnd = end;
            
            // Check if audio is loaded and has valid source
            if (!audio.src || audio.error) {
                console.warn('[PLAY] Audio source not ready or has error');
                return;
            }
            
            // Cancel any pending play request
            if (pendingPlayRequest) {
                console.log('[PLAY] Cancelling previous pending request');
                if (pendingPlayRequest.timeout) {
                    clearTimeout(pendingPlayRequest.timeout);
                }
                if (pendingPlayRequest.handler) {
                    audio.removeEventListener('canplay', pendingPlayRequest.handler);
                }
                if (pendingPlayRequest.errorHandler) {
                    audio.removeEventListener('error', pendingPlayRequest.errorHandler);
                }
                pendingPlayRequest = null;
            }
            
            // Always try to seek, even if readyState is low
            // This handles the case where rapid seeks cause readyState to drop
            console.log('[PLAY] Seeking to:', start);
            
            try {
                audio.currentTime = start;
            } catch (e) {
                console.error('[PLAY] Failed to set currentTime:', e);
                return;
            }
            
            const tryPlay = label => {
                console.log(`[PLAY] ${label} - readyState:`, audio.readyState);
                audio.play().then(() => {
                    markAudioReady(`play:${label}`);
                }).catch(e => {
                    console.error(`[PLAY] ${label} failed:`, e);
                });
            };

            // Attempt playback immediately in the current user gesture for iOS.
            tryPlay('Immediate play attempt');

            if (audio.readyState < 2) {
                console.log('[PLAY] Audio needs more data (readyState:', audio.readyState, '), waiting for canplay...');

                const onCanPlay = () => {
                    console.log('[PLAY] canplay event fired, retrying play');
                    if (pendingPlayRequest && pendingPlayRequest.handler === onCanPlay) {
                        clearTimeout(pendingPlayRequest.timeout);
                        pendingPlayRequest = null;
                    }
                    tryPlay('Play after canplay');
                };

                const onError = () => {
                    console.error('[PLAY] Error event fired during wait');
                    if (pendingPlayRequest && pendingPlayRequest.errorHandler === onError) {
                        clearTimeout(pendingPlayRequest.timeout);
                        pendingPlayRequest = null;
                    }
                };

                const timeout = setTimeout(() => {
                    console.error('[PLAY] Timeout waiting for canplay - readyState:', audio.readyState, 'networkState:', audio.networkState);
                    audio.removeEventListener('canplay', onCanPlay);
                    audio.removeEventListener('error', onError);
                    pendingPlayRequest = null;
                    tryPlay('Forced play after timeout');
                }, 3000);

                pendingPlayRequest = { handler: onCanPlay, errorHandler: onError, timeout };

                audio.addEventListener('canplay', onCanPlay, { once: true });
                audio.addEventListener('error', onError, { once: true });
            }
        }

        /** ------------------------------------------------- 
         *  高亮 & 自动滚动
         * ------------------------------------------------- */
        function highlight(idx, options = {}) {
            const { force = false } = options;
            if (idx === state.activeIdx && !force) return;

            // Clean up any previous dictation input
            const oldInput = content.querySelector('.dictation-input');
            if (oldInput) {
                const parentSentence = oldInput.closest('.sentence');
                if (parentSentence) {
                    parentSentence.querySelector('.en').style.display = '';
                }
                oldInput.remove();
            }

            const prev = content.querySelector('.sentence.active');
            if (prev) prev.classList.remove('active');

            const cur = content.querySelector(`.sentence[data-idx="${idx}"]`);
            if (cur) {
                cur.classList.add('active');
                const scrollBlockPosition = state.dictation ? 'start' : 'center';
                cur.scrollIntoView({behavior: 'smooth', block: scrollBlockPosition});

                const enDiv = cur.querySelector('.en');
                if (state.dictation && state.playbackMode === 'single-play') {
                    activateDictationForSentence(cur, idx);
                } else {
                    if (enDiv) enDiv.style.display = '';
                }
            }
            state.activeIdx = idx;
        }

        function activateDictationForSentence(sentenceEl, idx) {
            const enDiv = sentenceEl.querySelector('.en');
            if (enDiv) {
                enDiv.style.display = 'none';
            }

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'dictation-input';
            input.placeholder = '请输入英文句子...';
            sentenceEl.appendChild(input);
            input.focus();

            const correctAnswer = state.data[idx].en.replace(/[^a-zA-Z]/g, '').toLowerCase();

            input.addEventListener('input', e => {
                const userInput = e.target.value.replace(/[^a-zA-Z]/g, '').toLowerCase();

                if (userInput === correctAnswer) {
                    input.disabled = true;
                    const nextIdx = idx + 1;
                    if (nextIdx < state.data.length) {
                        const { start, end } = state.data[nextIdx];
                        playSegment(start, end);
                    } else {
                        audio.pause();
                        // Last sentence finished, clean up the UI
                        input.remove();
                        if (enDiv) {
                            enDiv.style.display = '';
                        }
                        sentenceEl.classList.remove('active');
                        state.activeIdx = -1;
                        // Scroll to top of page
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                }
            });
        }

        /** ------------------------------------------------- 
         *  Custom Player Logic
         * ------------------------------------------------- */
        playPauseBtn.addEventListener('click', () => {
            if (audio.paused) {
                if (state.activeIdx !== -1) {
                    // If there's an active sentence, play from its start
                    const { start, end } = state.data[state.activeIdx];
                    playSegment(start, end);
                } else {
                    // If no active sentence, play from the beginning of the first sentence
                    const { start, end } = state.data[0];
                    playSegment(start, end);
                }
            } else {
                audio.pause();
            }
        });

        audio.addEventListener('play', () => {
            playPauseBtn.classList.remove('play');
            playPauseBtn.classList.add('pause');
        });

        audio.addEventListener('pause', () => {
            playPauseBtn.classList.remove('pause');
            playPauseBtn.classList.add('play');
        });

        audio.addEventListener('loadedmetadata', () => {
            timeDisplay.textContent = `${formatTime(0)} / ${formatTime(audio.duration)}`;
        });

        progressBar.addEventListener('click', e => {
            const rect = progressBar.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const width = progressBar.clientWidth;
            const duration = audio.duration;
            if (!width || !duration || Number.isNaN(duration)) {
                return;
            }
            
            // Check if audio is ready
            if (audio.readyState < 2 || audio.error) {
                console.warn('Audio not ready for seeking');
                return;
            }
            
            const targetTime = (clickX / width) * duration;
            // Clear segmentEnd to prevent immediate loop back
            state.segmentEnd = 0;
            audio.currentTime = targetTime;
            updateHighlightForTime(targetTime, { force: true, updateSegmentEnd: false });
        });

        progressBar.addEventListener('pointerdown', e => {
            // Check if audio is ready before allowing drag
            if (audio.readyState < 2 || audio.error) {
                return;
            }
            
            if (e.pointerType === 'touch') {
                e.preventDefault();
            }
            const targetTime = updateSeekFromClientX(e.clientX);
            if (targetTime === null) {
                return;
            }
            isDraggingProgress = true;
            wasPlayingBeforeDrag = !audio.paused;
            if (wasPlayingBeforeDrag) {
                audio.pause();
            }
            if (progressBar.setPointerCapture) {
                try {
                    progressBar.setPointerCapture(e.pointerId);
                } catch (_) {
                    /* noop */
                }
            }
            pendingSeekTime = targetTime;
            updateHighlightForTime(targetTime, { force: true, updateSegmentEnd: false });
        });

        progressBar.addEventListener('pointermove', e => {
            if (!isDraggingProgress) return;
            if (e.pointerType === 'touch') {
                e.preventDefault();
            }
            const targetTime = updateSeekFromClientX(e.clientX);
            if (targetTime === null) {
                return;
            }
            pendingSeekTime = targetTime;
            updateHighlightForTime(targetTime, { force: true, updateSegmentEnd: false });
        });

        function finalizeSeek(e) {
            if (!isDraggingProgress) return;
            isDraggingProgress = false;
            if (progressBar.releasePointerCapture) {
                try {
                    progressBar.releasePointerCapture(e.pointerId);
                } catch (_) {
                    /* noop */
                }
            }
            if (pendingSeekTime !== null) {
                // Clear segmentEnd BEFORE setting currentTime to prevent immediate loop back
                state.segmentEnd = 0;
                audio.currentTime = pendingSeekTime;
            }
            if (wasPlayingBeforeDrag) {
                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {});
                }
            }
            pendingSeekTime = null;
        }

        progressBar.addEventListener('pointerup', finalizeSeek);
        progressBar.addEventListener('pointercancel', finalizeSeek);

        volumeBtn.addEventListener('click', () => {
            audio.muted = !audio.muted;
        });

        audio.addEventListener('volumechange', () => {
            if (audio.muted || audio.volume === 0) {
                volumeBtn.classList.remove('volume-high');
                volumeBtn.classList.add('volume-muted');
                volumeSlider.value = 0;
            } else {
                volumeBtn.classList.remove('volume-muted');
                volumeBtn.classList.add('volume-high');
                volumeSlider.value = audio.volume;
            }
        });

        volumeSlider.addEventListener('input', e => {
            audio.volume = e.target.value;
            audio.muted = e.target.value === '0';
        });


        /** ------------------------------------------------- 
         *  事件绑定（委托）
         * ------------------------------------------------- */
        content.addEventListener('click', e => {
            const target = e.target.closest('.sentence');
            if (!target) return;
            const idx = Number(target.dataset.idx);
            const {start, end} = state.data[idx];
            console.log('[CLICK] Sentence clicked - readyState:', audio.readyState, 'networkState:', audio.networkState, 'error:', audio.error);
            playSegment(start, end);
        });

        dictationModeCheckbox.addEventListener('change', e => {
            state.dictation = e.target.checked;

            // Re-render the current sentence to apply/remove dictation view
            if (state.activeIdx !== -1) {
                highlight(state.activeIdx, { force: true });
            }

            // If dictation is turned ON and audio is paused, start playing.
            if (state.dictation && audio.paused) {
                let playIndex = state.activeIdx;

                // If no sentence is active, start from the beginning.
                if (playIndex === -1) {
                    playIndex = 0;
                }

                // Ensure the index is valid before trying to play.
                if (playIndex >= 0 && playIndex < state.data.length) {
                    const { start, end } = state.data[playIndex];
                    playSegment(start, end);
                }
            }
        });

        modesContainer.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON') return;

            const mode = e.target.id.replace('mode-', '');
            if (['single-play', 'single-loop', 'continuous', 'ab-loop'].includes(mode)) {
                state.playbackMode = mode;
                localStorage.setItem('playbackMode', mode);

                // Update active button
                for (const child of modesContainer.children) {
                    child.classList.remove('active');
                }
                e.target.classList.add('active');

                // Show/hide A-B buttons
                if (mode === 'ab-loop') {
                    setAButton.style.display = 'inline-block';
                    setBButton.style.display = 'inline-block';
                } else {
                    setAButton.style.display = 'none';
                    setBButton.style.display = 'none';
                }

                // Handle dictation mode availability
                if (mode === 'single-play') {
                    dictationContainer.style.display = '';
                } else {
                    dictationContainer.style.display = 'none';
                    dictationModeCheckbox.checked = false;
                    state.dictation = false;
                    // If a sentence is active, re-highlight to remove dictation input
                    if (state.activeIdx !== -1) {
                        highlight(state.activeIdx, { force: true });
                    }
                }

                if (audio.paused) {
                    if (state.activeIdx !== -1) {
                        // If there's an active sentence, play from its start
                        let nextIdx = state.activeIdx;
                        if (mode === 'single-play' || mode === 'continuous') {
                            nextIdx++;
                        }
                        if (nextIdx === state.data.length) {
                            nextIdx = 0;
                        }
                        const { start, end } = state.data[nextIdx];
                        playSegment(start, end);
                    } else {
                        // If no active sentence, play from the beginning of the first sentence
                        const { start, end } = state.data[0];
                        playSegment(start, end);
                    }
                }
            }
        });

        setAButton.addEventListener('click', () => {
            if (state.activeIdx !== -1) {
                state.abLoop.a = state.data[state.activeIdx].start;
                setAButton.textContent = `A: ${state.abLoop.a.toFixed(1)}`;
                // Reset B if A is set after B
                state.abLoop.b = null;
                setBButton.textContent = '设置B点';
            }
        });

        setBButton.addEventListener('click', () => {
            if (state.activeIdx !== -1 && state.abLoop.a !== null) {
                const bPoint = state.data[state.activeIdx].end;
                if (bPoint > state.abLoop.a) {
                    state.abLoop.b = bPoint;
                    setBButton.textContent = `B: ${state.abLoop.b.toFixed(1)}`;
                    // Start playing the loop
                    audio.currentTime = state.abLoop.a;
                    audio.play();
                }
            }
        });

        const CUSTOM_SPEED_KEY = 'nceCustomPlaybackSpeed';
        let customSpeedPressTimer = null;
        let customSpeedLongPressTriggered = false;
        let suppressNextSpeedClick = false;

        function getCustomSpeed() {
            const stored = parseFloat(localStorage.getItem(CUSTOM_SPEED_KEY));
            if (!Number.isFinite(stored) || stored < 0.25 || stored > 5) {
                return 3;
            }
            return stored;
        }

        function formatSpeedLabel(value) {
            return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
        }

        function updateCustomSpeedButtonLabel(value = getCustomSpeed()) {
            if (customSpeedButton) {
                customSpeedButton.textContent = `${formatSpeedLabel(value)}x`;
            }
        }

        function clearCustomSpeedPressTimer() {
            if (customSpeedPressTimer) {
                clearTimeout(customSpeedPressTimer);
                customSpeedPressTimer = null;
            }
        }

        function promptCustomSpeed() {
            clearCustomSpeedPressTimer();
            const current = getCustomSpeed();
            const input = window.prompt('请输入自定义播放倍速 (0.25 - 5 之间)', formatSpeedLabel(current));
            if (input === null) {
                return;
            }
            const numeric = parseFloat(String(input).replace(/[^0-9.]+/g, ''));
            if (!Number.isFinite(numeric) || numeric < 0.25 || numeric > 5) {
                window.alert('请输入有效的倍速数值（0.25 - 5 之间）');
                return;
            }
            const normalized = Math.round(numeric * 100) / 100;
            localStorage.setItem(CUSTOM_SPEED_KEY, normalized);
            updateCustomSpeedButtonLabel(normalized);
            audio.playbackRate = normalized;
            localStorage.setItem('playbackSpeed', '3x');
            for (const child of speedContainer.children) {
                child.classList.remove('active');
            }
            if (customSpeedButton) {
                customSpeedButton.classList.add('active');
            }
        }

        if (customSpeedButton) {
            updateCustomSpeedButtonLabel();
            customSpeedButton.addEventListener('pointerdown', e => {
                if (e.button !== undefined && e.button !== 0) {
                    return;
                }
                customSpeedLongPressTriggered = false;
                clearCustomSpeedPressTimer();
                customSpeedPressTimer = setTimeout(() => {
                    customSpeedLongPressTriggered = true;
                    promptCustomSpeed();
                }, 600);
            });
            const cancelCustomSpeedPress = e => {
                if (customSpeedLongPressTriggered) {
                    suppressNextSpeedClick = true;
                    if (e) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
                clearCustomSpeedPressTimer();
            };
            customSpeedButton.addEventListener('pointerup', cancelCustomSpeedPress);
            customSpeedButton.addEventListener('pointerleave', cancelCustomSpeedPress);
            customSpeedButton.addEventListener('pointercancel', cancelCustomSpeedPress);
        }

        speedContainer.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON') return;
            if (suppressNextSpeedClick) {
                suppressNextSpeedClick = false;
                return;
            }

            const speed = e.target.id.replace('speed-', ''); // e.g., '1x', '3x'
            let playbackRate = parseFloat(speed);
            if (e.target.id === 'speed-3x') {
                playbackRate = getCustomSpeed();
                localStorage.setItem('playbackSpeed', '3x');
            } else {
                localStorage.setItem('playbackSpeed', speed);
            }
            audio.playbackRate = playbackRate;

            // Update active button
            for (const child of speedContainer.children) {
                child.classList.remove('active');
            }
            e.target.classList.add('active');
        });

        audio.addEventListener('timeupdate', () => {
            const cur = audio.currentTime;
            const duration = audio.duration;

            // Update progress bar and time display (skip if dragging to avoid flickering)
            if (duration && !isDraggingProgress) {
                progress.style.width = `${(cur / duration) * 100}%`;
                timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(duration)}`;
            }

            // Skip all playback logic while dragging
            if (isDraggingProgress) {
                return;
            }

            // A-B Loop logic
            if (state.playbackMode === 'ab-loop' && state.abLoop.a !== null && state.abLoop.b !== null && cur >= state.abLoop.b) {
                audio.currentTime = state.abLoop.a;
                return; // Return to avoid other logic
            }

            // Sentence-based logic for other modes
            if (state.segmentEnd && cur >= state.segmentEnd) {
                let shouldReturn = true;
                switch (state.playbackMode) {
                    case 'single-play':
                        audio.pause();
                        // By returning here, we prevent the findIndex and highlight logic below from running,
                        // which stops the highlight from jumping to the next sentence.
                        return;
                    case 'single-loop':
                        if (state.activeIdx !== -1) {
                            const { start } = state.data[state.activeIdx];
                            audio.currentTime = start;
                        }
                        break;
                    case 'continuous':
                    case 'ab-loop':
                        const nextIdx = state.activeIdx + 1;
                        if (state.activeIdx !== -1 && nextIdx < state.data.length) {
                            const {start, end} = state.data[nextIdx];
                            playSegment(start, end);
                            shouldReturn = false; // Allow highlight to update
                        } else {
                            audio.pause();
                            state.segmentEnd = 0;
                        }
                        break;
                }
                if (shouldReturn) return;
            }

            // Find and highlight current sentence
            const idx = findSentenceIndexAtTime(cur);
            if (idx !== -1) {
                highlight(idx);
                // Update segmentEnd for the current sentence if not already set
                if (!state.segmentEnd && state.data[idx]) {
                    state.segmentEnd = state.data[idx].end;
                }
            } else {
                // No sentence at current time - clear segmentEnd to prevent issues
                state.segmentEnd = 0;
            }
        });

        function loadSettings() {
            const savedMode = localStorage.getItem('playbackMode') || 'single-play';
            const savedSpeed = localStorage.getItem('playbackSpeed') || '1x';

            // Apply mode
            state.playbackMode = savedMode;
            document.getElementById(`mode-${savedMode}`).classList.add('active');
            if (savedMode === 'ab-loop') {
                setAButton.style.display = 'inline-block';
                setBButton.style.display = 'inline-block';
            }

            // Handle dictation mode availability on load
            if (savedMode === 'single-play') {
                dictationContainer.style.display = '';
            } else {
                dictationContainer.style.display = 'none';
            }

            // Apply speed
            const savedButton = document.getElementById(`speed-${savedSpeed}`);
            const appliedSpeed = savedSpeed === '3x' ? getCustomSpeed() : parseFloat(savedSpeed);
            audio.playbackRate = appliedSpeed;
            if (savedButton) {
                savedButton.classList.add('active');
            }
            if (customSpeedButton) {
                updateCustomSpeedButtonLabel();
            }
        }

        // Keyboard shortcuts handler
        document.addEventListener('keydown', e => {
            // If in dictation mode, handle dictation-specific behavior
            if (state.dictation) {
                const dictationInput = content.querySelector('.dictation-input');
                if (dictationInput) {
                    // If focus is already on an interactive element, do nothing for dictation.
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
                        return;
                    }
                    dictationInput.focus();
                }
                // In dictation mode, ignore keyboard shortcuts except for specific keys
                return;
            }

            // Don't handle shortcuts if user is typing in an input field or button
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }

            // Don't handle shortcuts if modifier keys are pressed (except for system shortcuts)
            if (e.ctrlKey || e.metaKey || e.altKey) {
                return;
            }

            switch (e.key) {
                case 'ArrowLeft':
                    // Left arrow: Previous sentence
                    e.preventDefault();
                    if (state.activeIdx > 0) {
                        const prevIdx = state.activeIdx - 1;
                        const { start, end } = state.data[prevIdx];
                        playSegment(start, end);
                    }
                    break;

                case 'ArrowRight':
                    // Right arrow: Next sentence
                    e.preventDefault();
                    if (state.activeIdx < state.data.length - 1) {
                        const nextIdx = state.activeIdx + 1;
                        const { start, end } = state.data[nextIdx];
                        playSegment(start, end);
                    }
                    break;

                case ' ':
                    // Space: Play/Pause
                    e.preventDefault();
                    if (audio.paused) {
                        if (state.activeIdx !== -1) {
                            const { start, end } = state.data[state.activeIdx];
                            playSegment(start, end);
                        } else if (state.data.length > 0) {
                            const { start, end } = state.data[0];
                            playSegment(start, end);
                        }
                    } else {
                        audio.pause();
                    }
                    break;

                case 'ArrowUp':
                    // Up arrow: Previous speed
                    e.preventDefault();
                    changeSpeed('previous');
                    break;

                case 'ArrowDown':
                    // Down arrow: Next speed
                    e.preventDefault();
                    changeSpeed('next');
                    break;
            }
        });

        // Function to handle speed changes
        function changeSpeed(direction) {
            const speedButtons = Array.from(speedContainer.children);
            const activeButton = speedButtons.find(btn => btn.classList.contains('active'));
            let currentIndex = activeButton ? speedButtons.indexOf(activeButton) : 0;

            if (direction === 'previous') {
                currentIndex = currentIndex > 0 ? currentIndex - 1 : speedButtons.length - 1;
            } else if (direction === 'next') {
                currentIndex = currentIndex < speedButtons.length - 1 ? currentIndex + 1 : 0;
            }

            const targetButton = speedButtons[currentIndex];
            if (targetButton) {
                targetButton.click();
            }
        }

        // 初始化
        loadSettings();
        loadLrc().then(r => {
            // LRC loaded successfully
        });

        // Lesson navigation functionality
        const prevLessonBtn = document.getElementById('prev-lesson');
        const nextLessonBtn = document.getElementById('next-lesson');
        let defaultLessonsMap = {};
        let currentLessonIndex = isCustomLesson ? customLessonIndex : -1;

        // Load lessons data
        async function loadLessonsData() {
            try {
                const dataRes = await fetch('static/data.json');
                defaultLessonsMap = await dataRes.json();
            } catch (error) {
                console.error('Failed to load lessons data:', error);
                defaultLessonsMap = {};
            } finally {
                refreshCustomLessonsMap();
                updateNavigationButtons();
            }
        }

        // Update navigation buttons state
        function updateNavigationButtons() {
            if (!prevLessonBtn || !nextLessonBtn) {
                return;
            }

            if (isCustomLesson) {
                const lessons = Array.isArray(customLessonsMap[customBookName]) ? customLessonsMap[customBookName] : [];
                prevLessonBtn.disabled = customLessonIndex <= 0;
                nextLessonBtn.disabled = customLessonIndex >= lessons.length - 1;
            } else {
                const lessons = defaultLessonsMap[String(defaultBookNumber)] || [];
                const index = lessons.findIndex((lesson) => lesson.filename === lessonSlug);
                currentLessonIndex = index;
                prevLessonBtn.disabled = index <= 0;
                nextLessonBtn.disabled = index === -1 || index >= lessons.length - 1;
            }
        }

        if (prevLessonBtn) {
            prevLessonBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (isCustomLesson) {
                    if (customLessonIndex > 0) {
                        const lessons = Array.isArray(customLessonsMap[customBookName]) ? customLessonsMap[customBookName] : [];
                        const prevLesson = lessons[customLessonIndex - 1];
                        if (prevLesson) {
                            window.location.href = `lesson.html#CUSTOM/${encodeURIComponent(customBookName)}/${customLessonIndex - 1}`;
                            window.location.reload();
                        }
                    }
                    return;
                }

                const lessons = defaultLessonsMap[String(defaultBookNumber)] || [];
                if (currentLessonIndex > 0) {
                    const prevLesson = lessons[currentLessonIndex - 1];
                    if (prevLesson) {
                        window.location.href = `lesson.html#NCE${defaultBookNumber}/${encodeURIComponent(prevLesson.filename)}`;
                        window.location.reload();
                    }
                }
            });
        }

        if (nextLessonBtn) {
            nextLessonBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (isCustomLesson) {
                    const lessons = Array.isArray(customLessonsMap[customBookName]) ? customLessonsMap[customBookName] : [];
                    if (customLessonIndex < lessons.length - 1) {
                        const nextLesson = lessons[customLessonIndex + 1];
                        if (nextLesson) {
                            window.location.href = `lesson.html#CUSTOM/${encodeURIComponent(customBookName)}/${customLessonIndex + 1}`;
                            window.location.reload();
                        }
                    }
                    return;
                }

                const lessons = defaultLessonsMap[String(defaultBookNumber)] || [];
                if (currentLessonIndex > -1 && currentLessonIndex < lessons.length - 1) {
                    const nextLesson = lessons[currentLessonIndex + 1];
                    if (nextLesson) {
                        window.location.href = `lesson.html#NCE${defaultBookNumber}/${encodeURIComponent(nextLesson.filename)}`;
                        window.location.reload();
                    }
                }
            });
        }

        loadLessonsData();

    })
})();
