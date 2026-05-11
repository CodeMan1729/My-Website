(function () {
    var topicNav = document.getElementById('topicNav');
    var wordList = document.getElementById('wordList');
    var controls = document.getElementById('controls');
    var playBtn = document.getElementById('playBtn');
    var stopBtn = document.getElementById('stopBtn');
    var playIcon = document.getElementById('playIcon');
    var pauseIcon = document.getElementById('pauseIcon');
    var progressInfo = document.getElementById('progressInfo');
    var speechWarning = document.getElementById('speechWarning');

    var words = [];
    var currentIndex = 0;
    var isPlaying = false;
    var isPaused = false;
    var activeTopic = null;
    var speechTimeout = null;
    var currentUtterance = null;

    var hasSpeech = 'speechSynthesis' in window;
    var preferredVoice = null;

    if (!hasSpeech) {
        speechWarning.style.display = 'block';
    } else {
        // Find Microsoft natural voice
        function findVoice() {
            var voices = speechSynthesis.getVoices();
            for (var i = 0; i < voices.length; i++) {
                if (voices[i].name.indexOf('Microsoft') !== -1 &&
                    voices[i].name.indexOf('Online (Natural)') !== -1 &&
                    voices[i].lang.indexOf('en-US') !== -1) {
                    preferredVoice = voices[i];
                    return;
                }
            }
            // Fallback: any Microsoft en-US natural voice
            for (var i = 0; i < voices.length; i++) {
                if (voices[i].name.indexOf('Natural') !== -1 &&
                    voices[i].lang.indexOf('en-US') !== -1) {
                    preferredVoice = voices[i];
                    return;
                }
            }
        }
        findVoice();
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = findVoice;
        }
    }

    // Load topic index
    fetch('./static/data/vocabulary/index.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            renderTopics(data.topics);
        })
        .catch(function () {
            topicNav.innerHTML = '<div class="topic-loading">Failed to load topics</div>';
        });

    function renderTopics(topics) {
        topicNav.innerHTML = '';
        topics.forEach(function (topic) {
            var btn = document.createElement('button');
            btn.className = 'topic-btn';
            btn.innerHTML =
                '<span class="topic-name-cn">' + topic.nameCn + '</span>' +
                '<span class="topic-meta">' + topic.name + ' &middot; ' + topic.wordCount + ' words</span>';
            btn.addEventListener('click', function () {
                loadTopic(topic, btn);
            });
            topicNav.appendChild(btn);
        });
    }

    function loadTopic(topic, btn) {
        // Stop any ongoing playback
        stopPlayback();

        // Update active button
        var btns = topicNav.querySelectorAll('.topic-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.remove('active');
        }
        btn.classList.add('active');
        activeTopic = topic;

        wordList.innerHTML = '<div class="word-placeholder">Loading...</div>';

        fetch('./static/data/vocabulary/' + topic.file)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                words = data.words || [];
                renderWords();
                controls.style.display = words.length > 0 ? 'flex' : 'none';
                updateProgress();
            })
            .catch(function () {
                wordList.innerHTML = '<div class="word-placeholder">Failed to load words</div>';
            });
    }

    function renderWords() {
        wordList.innerHTML = '';
        if (words.length === 0) {
            wordList.innerHTML = '<div class="word-placeholder">No words in this topic</div>';
            return;
        }
        words.forEach(function (w, i) {
            var div = document.createElement('div');
            div.className = 'word-item';
            div.setAttribute('data-index', i);
            div.innerHTML =
                '<span class="word-en">' + escapeHtml(w.word) + '</span>' +
                '<span class="word-cn">' + escapeHtml(w.translation) + '</span>';
            wordList.appendChild(div);
        });
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function highlightWord(index) {
        var items = wordList.querySelectorAll('.word-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('highlight');
        }
        if (index >= 0 && index < items.length) {
            items[index].classList.add('highlight');
            items[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function updateProgress() {
        if (words.length === 0) {
            progressInfo.textContent = '';
            return;
        }
        progressInfo.textContent = (currentIndex + 1) + ' / ' + words.length;
    }

    function setPlayingUI(playing) {
        if (playing) {
            playIcon.style.display = 'none';
            pauseIcon.style.display = 'block';
        } else {
            playIcon.style.display = 'block';
            pauseIcon.style.display = 'none';
        }
    }

    function speakWord(index) {
        if (index >= words.length) {
            // Reached end
            stopPlayback();
            return;
        }

        currentIndex = index;
        updateProgress();
        highlightWord(index);

        if (!hasSpeech) return;

        var utterance = new SpeechSynthesisUtterance(words[index].word);
        utterance.lang = 'en-US';
        utterance.rate = 0.9;
        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }

        currentUtterance = utterance;

        utterance.onend = function () {
            if (currentUtterance !== utterance) return;
            if (!isPlaying || isPaused) return;
            speakWord(index + 1);
        };

        utterance.onerror = function () {
            if (currentUtterance !== utterance) return;
            if (!isPlaying || isPaused) return;
            speakWord(index + 1);
        };

        speechSynthesis.speak(utterance);
    }

    function startPlayback() {
        if (words.length === 0) return;
        isPlaying = true;
        isPaused = false;
        setPlayingUI(true);
        speakWord(currentIndex);
    }

    function pausePlayback() {
        isPaused = true;
        isPlaying = false;
        currentUtterance = null;
        setPlayingUI(false);
        if (hasSpeech) {
            speechSynthesis.cancel();
        }
        clearTimeout(speechTimeout);
    }

    function stopPlayback() {
        isPlaying = false;
        isPaused = false;
        currentIndex = 0;
        currentUtterance = null;
        setPlayingUI(false);
        if (hasSpeech) {
            speechSynthesis.cancel();
        }
        clearTimeout(speechTimeout);
        highlightWord(-1);
        updateProgress();
    }

    // Button events
    playBtn.addEventListener('click', function () {
        if (isPlaying) {
            pausePlayback();
        } else {
            startPlayback();
        }
    });

    stopBtn.addEventListener('click', function () {
        stopPlayback();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
        // Don't trigger if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (words.length === 0) return;

        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            if (isPlaying) {
                pausePlayback();
            } else {
                startPlayback();
            }
        } else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
            e.preventDefault();
            if (currentIndex > 0) {
                currentUtterance = null;
                if (hasSpeech) speechSynthesis.cancel();
                currentIndex = currentIndex - 1;
                if (isPlaying) {
                    speakWord(currentIndex);
                } else {
                    updateProgress();
                    highlightWord(currentIndex);
                }
            }
        } else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') {
            e.preventDefault();
            if (currentIndex < words.length - 1) {
                currentUtterance = null;
                if (hasSpeech) speechSynthesis.cancel();
                currentIndex = currentIndex + 1;
                if (isPlaying) {
                    speakWord(currentIndex);
                } else {
                    updateProgress();
                    highlightWord(currentIndex);
                }
            }
        }
    });
})();
