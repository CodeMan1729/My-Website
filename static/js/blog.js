(function () {
    var postList = document.getElementById('postList');

    fetch('./static/data/blog/index.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            renderPosts(data.posts);
        })
        .catch(function () {
            postList.innerHTML = '<div class="post-placeholder">Failed to load posts</div>';
        });

    function renderPosts(posts) {
        if (!posts || posts.length === 0) {
            postList.innerHTML = '<div class="post-placeholder">No posts yet</div>';
            return;
        }

        postList.innerHTML = '';

        // Sort by date descending (newest first)
        posts.sort(function (a, b) {
            return b.date.localeCompare(a.date);
        });

        posts.forEach(function (post) {
            var card = document.createElement('a');
            card.className = 'post-card';
            card.href = './static/data/blog/' + post.folder + '/index.html';

            var tagsHtml = '';
            if (post.tags && post.tags.length > 0) {
                post.tags.forEach(function (tag) {
                    tagsHtml += '<span class="post-tag">' + escapeHtml(tag) + '</span>';
                });
            }

            var subtitleHtml = '';
            if (post.subtitle) {
                subtitleHtml = '<div class="post-card-subtitle">' + escapeHtml(post.subtitle) + '</div>';
            }

            card.innerHTML =
                '<div class="post-card-title">' + escapeHtml(post.title) + '</div>' +
                subtitleHtml +
                '<div class="post-card-summary">' + escapeHtml(post.summary) + '</div>' +
                '<div class="post-card-meta">' +
                    '<span class="post-card-date">' + escapeHtml(post.date) + '</span>' +
                    '<div class="post-card-tags">' + tagsHtml + '</div>' +
                '</div>';

            postList.appendChild(card);
        });
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }
})();
