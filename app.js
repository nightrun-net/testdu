import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';

const supabaseUrl = 'https://vycidctybcihudvuydwj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5Y2lkY3R5YmNpaHVkdnV5ZHdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NDE5MjMsImV4cCI6MjEwNjAxNzkyM30.WtaUyVNEBdSmodPCNFGM9X_ArW07QcemmyQIGQeLmyg';


function assertPublicSupabaseKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('Missing public Supabase API key.');
  }
  if (key.startsWith('sb_publishable_')) return;
  if (key.startsWith('sb_secret_')) {
    throw new Error('A Supabase secret key cannot be used in browser code.');
  }
  try {
    const parts = key.split('.');
    if (parts.length !== 3) throw new Error('Unrecognized key format');
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    if (payload.role !== 'anon') {
      throw new Error('Non-anon JWT supplied to public JavaScript');
    }
  } catch {
    throw new Error('Use an anon or publishable Supabase key in app.js, never service_role.');
  }
}

assertPublicSupabaseKey(supabaseKey);

const supabase = createClient(supabaseUrl, supabaseKey);

let currentUser = null;
let currentProfile = null;
let currentDeletePostId = null;

window.currentCommentPostId = null;
window.currentLoadedPosts = [];

const MEDIA_BUCKET = 'media';
const DEFAULT_AVATAR =
  'https://cdn-icons-png.flaticon.com/512/149/149071.png';

// SECURITY HELPERS

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Display-only text cleanup: keep paragraphs, remove excessive empty lines.
// Saved post descriptions in Supabase are never modified.
function normalizeDisplayDescription(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function withTimeout(task, ms, label) {
  let timer;

  return Promise.race([
    Promise.resolve(task),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label + ' timed out.')),
        ms
      );
    })
  ]).finally(() => clearTimeout(timer));
}

const uploadExt = (file) => ({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
}[file?.type] || null);

const UUID_RE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const mediaPathPattern = new RegExp(
  `^(?:${UUID_RE}/(?:avatars/)?[A-Za-z0-9][A-Za-z0-9._-]{0,199}|avatars/${UUID_RE}/[A-Za-z0-9][A-Za-z0-9._-]{0,199})$`,
  'i'
);

function isValidMediaPath(value) {
  return (
    typeof value === 'string' &&
    mediaPathPattern.test(value) &&
    !value.split('/').some(
      part => part === '.' || part === '..'
    ) &&
    !/[\\%?#\x00-\x1f]/.test(value)
  );
}

// PRIVATE MEDIA SIGNED URL

const signedUrlCache = new Map();

async function getSignedUrl(rawPath) {
  if (typeof rawPath !== 'string') return null;

  const path = rawPath.trim();

  if (!isValidMediaPath(path)) return null;

  const now = Date.now();
  const cached = signedUrlCache.get(path);

  if (cached && cached.expires > now) {
    return cached.promise;
  }

  const promise = (async () => {
    try {
      const { data, error } = await withTimeout(
        supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(path, 3600),
        6500,
        'Media link'
      );

      if (error) throw error;
      if (!data?.signedUrl) return null;

      const resolved = new URL(
        data.signedUrl,
        supabaseUrl
      );

      if (
        resolved.origin !== new URL(supabaseUrl).origin ||
        !resolved.pathname.startsWith(
          '/storage/v1/object/sign/media/'
        )
      ) {
        return null;
      }

      return resolved.href;
    } catch (error) {
      console.warn(
        'Media signing failed:',
        error.message
      );
      return null;
    }
  })();

  signedUrlCache.set(path, {
    promise,
    expires: now + 50 * 60 * 1000
  });

  promise.then(url => {
    if (
      !url &&
      signedUrlCache.get(path)?.promise === promise
    ) {
      signedUrlCache.delete(path);
    }
  });

  return promise;
}

// MEDIA ERROR HANDLING

const mediaRetries = new WeakMap();

function storagePathOf(rawUrl) {
  try {
    const target = new URL(rawUrl);

    if (
      target.origin !==
      new URL(supabaseUrl).origin
    ) {
      return null;
    }

    const match = target.pathname.match(
      /^\/storage\/v1\/object\/(?:public|sign)\/media\/(.+)$/
    );

    if (!match) return null;

    const path = decodeURIComponent(match[1]);

    return isValidMediaPath(path) ? path : null;
  } catch {
    return null;
  }
}

function showMediaError(element) {
  element.style.display = 'none';

  const parent = element.parentElement;

  if (
    !parent ||
    parent.querySelector('.media-error-message')
  ) {
    return;
  }

  parent.classList.add('media-has-error');

  const hint = document.createElement('div');
  hint.className = 'media-error-message';

  hint.innerHTML =
    '<i class="fa-regular fa-image" aria-hidden="true"></i><span>Image unavailable</span>';

  parent.appendChild(hint);
}

document.addEventListener('load', event => {
  const element = event.target;

  if (
    element instanceof HTMLImageElement &&
    mediaRetries.has(element)
  ) {
    element.style.opacity = '';
    element.style.display = '';
  }
}, true);

document.addEventListener('error', async event => {
  const element = event.target;

  if (
    !(element instanceof HTMLImageElement) &&
    !(element instanceof HTMLVideoElement)
  ) {
    return;
  }

  const prior = mediaRetries.get(element) || 0;

  if (prior > 0) {
    if (element instanceof HTMLImageElement) {
      showMediaError(element);
    }
    return;
  }

  mediaRetries.set(element, 1);

  const url = element.currentSrc || element.src;
  const path = storagePathOf(url);

  if (!path) {
    if (element instanceof HTMLImageElement) {
      showMediaError(element);
    }
    return;
  }

  try {
    signedUrlCache.delete(path);

    const alternate = await getSignedUrl(path);

    if (
      alternate &&
      element.isConnected &&
      alternate !== url
    ) {
      element.src = alternate;
      return;
    }
  } catch (error) {
    console.warn(
      'Media retry failed:',
      error.message
    );
  }

  if (element instanceof HTMLImageElement) {
    showMediaError(element);
  }
}, true);

// MAIN APPLICATION

document.addEventListener(
  'DOMContentLoaded',
  async () => {

  const currentPageStr = window.location.pathname
    .split('/')
    .pop()
    .toLowerCase();

  const isIndexPage =
    currentPageStr === '' ||
    currentPageStr.includes('index');

  const isHomePage =
    currentPageStr.includes('home');

  const isLikedPage =
    currentPageStr.includes('liked');

  const isUploadPage =
    currentPageStr.includes('upload');

  const isProfilePage =
    currentPageStr.includes('profile');

  // SAFE EVENT DELEGATION

  document.addEventListener('click', event => {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) return;
    const trigger = eventTarget.closest(
      '[data-action]'
    );

    if (!trigger) return;

    const action = trigger.dataset.action;
    const id = trigger.dataset.postId;

    switch (action) {
      case 'reload':
        location.reload();
        break;

      case 'zoom':
        window.openZoom?.(
          id,
          Number(trigger.dataset.index || 0)
        );
        break;

      case 'edit-post':
        window.editPost?.(id);
        break;

      case 'delete-post':
        window.confirmDelete?.(id);
        break;

      case 'toggle-like':
        window.toggleLike?.(id, trigger);
        break;

      case 'open-comments':
        window.openComments?.(id);
        break;

      case 'toggle-description':
        window.toggleInlineDesc?.(
          trigger,
          event
        );
        break;
    }
  });

  // AUTHENTICATION

  window.DugitalLoader?.show(
    isIndexPage
      ? 'Connecting to Dugital...'
      : 'Loading your space...'
  );

  let session;

  try {
    const result = await withTimeout(
      supabase.auth.getSession(),
      12000,
      'Session check'
    );

    if (result.error) throw result.error;

    session = result.data.session;
  } catch (error) {
    window.DugitalLoader?.hide();

    document.getElementById('auth-error')
      ?.replaceChildren(
        document.createTextNode(
          error.message ||
          'Could not connect. Please refresh.'
        )
      );

    if (!isIndexPage) {
      const feed = document.getElementById(
        'posts-feed'
      );

      if (feed) {
        feed.innerHTML =
          '<div class="loading-state" role="alert">Could not verify your session. <button class="retry-button" data-action="reload">Retry</button></div>';
      } else {
        window.DugitalLoader?.fail(
          'Could not check your session.'
        );
      }
    }

    return;
  }

  if (!session && !isIndexPage) {
    window.location.href = 'index.html';
    return;
  }

  if (session && isIndexPage) {
    window.location.href = 'home.html';
    return;
  }

  let profilePromise = Promise.resolve(null);

  if (session) {
    currentUser = session.user;

    profilePromise = withTimeout(
      supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .eq('id', currentUser.id)
        .single(),
      8500,
      'Profile request'
    ).then(result => {
      if (result.error) throw result.error;

      currentProfile = result.data;
      return result.data;
    }).catch(error => {
      console.warn(
        'Profile loading failed:',
        error.message
      );
      return null;
    });
  }

  // LOGIN SCREEN

  if (isIndexPage) {
    window.DugitalLoader?.hide();

    const emailInput =
      document.getElementById('email');

    const passInput =
      document.getElementById('password');

    const loginBtn =
      document.getElementById('login-btn');

    emailInput?.addEventListener(
      'keypress',
      event => {
        if (event.key === 'Enter') {
          passInput?.focus();
        }
      }
    );

    passInput?.addEventListener(
      'keypress',
      event => {
        if (event.key === 'Enter') {
          loginBtn?.click();
        }
      }
    );

    loginBtn?.addEventListener(
      'click',
      async () => {
        if (loginBtn.disabled) return;

        const errorNode =
          document.getElementById('auth-error');

        if (errorNode) errorNode.textContent = '';

        if (
          !emailInput?.value.trim() ||
          !passInput?.value
        ) {
          if (errorNode) {
            errorNode.textContent =
              'Enter your email and password.';
          }
          return;
        }

        loginBtn.disabled = true;

        window.DugitalLoader?.show(
          'Signing you in...'
        );

        try {
          const { error } = await withTimeout(
            supabase.auth.signInWithPassword({
              email: emailInput.value.trim(),
              password: passInput.value
            }),
            18000,
            'Sign in'
          );

          if (error) throw error;

          window.DugitalLoader?.show(
            'Preparing your news feed...'
          );

          window.location.href = 'home.html';
        } catch (error) {
          if (errorNode) {
            errorNode.textContent =
              error.message || 'Could not sign in.';
          }

          window.DugitalLoader?.hide();
          loginBtn.disabled = false;
        }
      }
    );

    // DISABLE REGISTRATION UI
    document.querySelectorAll(
      '#signup-btn, [data-auth="signup"]'
    ).forEach(element => element.remove());
  }

  // HOME AND LIKED POSTS

  if (isHomePage || isLikedPage) {
    const postsFeed =
      document.getElementById('posts-feed');

    window.updateSliderCounter = (
      element,
      postId,
      total
    ) => {
      const width = element.clientWidth;

      const currentIndex =
        Math.round(element.scrollLeft / width) + 1;

      const counter =
        document.getElementById(
          'zoom-slider-counter'
        );

      if (counter) {
        counter.innerText =
          `${currentIndex} / ${total}`;
      }
    };

    // LOAD POSTS

    async function loadPosts() {
      window.DugitalLoader?.show(
        'Loading the latest stories...'
      );

      try {
        let myLikedIds = [];

        const postsRequest = withTimeout(
          supabase
            .from('posts')
            .select(`
              *,
              profiles:user_id(full_name, avatar_url),
              likes(user_id),
              comments(id)
            `)
            .order('created_at', {
              ascending: false
            }),
          16000,
          'Posts request'
        );

        const likesRequest = currentUser
          ? withTimeout(
              supabase
                .from('likes')
                .select('post_id')
                .eq('user_id', currentUser.id),
              9000,
              'Likes request'
            ).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] });

        // Try the original relational feed query first. If a related table
        // has a broken relationship/grant, use a plain posts query so the
        // entire news feed does not disappear. Backend RLS still applies.
        let { data: posts, error: postsError } = await postsRequest;
        if (postsError) {
          console.warn('[Dugital] Feed relation query failed:', {
            code: postsError.code,
            message: postsError.message,
            details: postsError.details,
            hint: postsError.hint
          });
          const fallback = await withTimeout(
            supabase.from('posts').select('*').order('created_at', { ascending: false }),
            16000,
            'Simple posts request'
          );
          if (fallback.error) {
            console.error('[Dugital] Posts SELECT denied/failed:', {
              code: fallback.error.code,
              message: fallback.error.message,
              details: fallback.error.details,
              hint: fallback.error.hint
            });
            throw fallback.error;
          }
          posts = fallback.data || [];
          // Optional enrichment. Failure here must NOT hide existing posts.
          const authorIds = [...new Set(posts.map(p => p.user_id).filter(Boolean))];
          const postIds = posts.map(p => p.id);
          const profileMap = new Map();
          const likesMap = new Map();
          const commentsMap = new Map();
          const batches = (items, size = 60) =>
            Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
          try {
            for (const ids of batches(authorIds)) {
              const { data, error } = await supabase.from('profiles')
                .select('id,full_name,avatar_url').in('id', ids);
              if (error) throw error;
              (data || []).forEach(p => profileMap.set(String(p.id), p));
            }
          } catch (e) { console.warn('[Dugital] Profile enrichment:', e.message); }
          try {
            for (const ids of batches(postIds)) {
              const { data, error } = await supabase.from('likes')
                .select('post_id,user_id').in('post_id', ids);
              if (error) throw error;
              (data || []).forEach(item => {
                const key = String(item.post_id);
                if (!likesMap.has(key)) likesMap.set(key, []);
                likesMap.get(key).push({ user_id: item.user_id });
              });
            }
          } catch (e) { console.warn('[Dugital] Likes enrichment:', e.message); }
          try {
            for (const ids of batches(postIds)) {
              const { data, error } = await supabase.from('comments')
                .select('id,post_id').in('post_id', ids);
              if (error) throw error;
              (data || []).forEach(item => {
                const key = String(item.post_id);
                if (!commentsMap.has(key)) commentsMap.set(key, []);
                commentsMap.get(key).push({ id: item.id });
              });
            }
          } catch (e) { console.warn('[Dugital] Comments enrichment:', e.message); }
          posts = posts.map(post => ({
            ...post,
            profiles: profileMap.get(String(post.user_id)) || null,
            likes: likesMap.get(String(post.id)) || [],
            comments: commentsMap.get(String(post.id)) || []
          }));
        }

        if (isLikedPage) {
          const { data } = await likesRequest;

          myLikedIds = (data || []).map(
            like => String(like.post_id)
          );
        } else {
          likesRequest.then(({ data }) => {
            const ids = new Set(
              (data || []).map(
                like => String(like.post_id)
              )
            );

            document.querySelectorAll(
              '.post-action-btn.like-btn'
            ).forEach(button => {
              const id =
                button.getAttribute(
                  'data-post-id'
                );

              if (
                button.dataset.manuallyToggled ===
                'true'
              ) {
                return;
              }

              const liked = ids.has(id);

              button.classList.toggle(
                'liked',
                liked
              );

              const heart =
                button.querySelector(
                  '.action-icon i'
                );

              if (heart) {
                heart.className =
                  (liked ? 'fa-solid' : 'fa-regular') +
                  ' fa-heart';
              }

              button.setAttribute(
                'aria-pressed',
                String(liked)
              );
            });
          }).catch(console.warn);
        }

        if (!posts) {
          throw new Error('No posts returned.');
        }

        window.currentLoadedPosts = posts;
        postsFeed.innerHTML = '';

        if (
          isLikedPage &&
          myLikedIds.length === 0
        ) {
          postsFeed.innerHTML =
            '<p style="text-align:center;margin-top:50px;color:#888;">چو پۆست نەهاتینە لایك كرن...</p>';
          return;
        }

        // RENDER EACH POST

        for (
          const [postIndex, post]
          of posts.entries()
        ) {
          const safeLikes =
            Array.isArray(post.likes)
              ? post.likes : [];

          const safeComments =
            Array.isArray(post.comments)
              ? post.comments : [];

          const isLiked =
            myLikedIds.includes(String(post.id));

          if (isLikedPage && !isLiked) {
            continue;
          }

          const postDate =
            new Date(post.created_at);

          const formattedDate =
            `${postDate.getDate()}/${postDate.getMonth() + 1}/${postDate.getFullYear()} ` +
            postDate.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            });

          let mediaHTML = '';

          // SAFE MEDIA RENDERING

          if (post.media_url) {
            const rawUrls = String(
              post.media_url
            ).split(',').filter(Boolean);

            const totalMedia = rawUrls.length;

            const displayLimit =
              post.media_type === 'image'
                ? (
                    totalMedia === 3 ? 3 :
                    totalMedia === 2 ? 2 :
                    totalMedia >= 6 ? 6 : 4
                  )
                : 1;

            const urls = await Promise.all(
              rawUrls
                .slice(0, displayLimit)
                .map(getSignedUrl)
            );

            if (
              post.media_type === 'image' &&
              totalMedia > 1
            ) {
              let gridImages = '';

              let maxDisplay = 4;

              if (totalMedia === 2) maxDisplay = 2;
              else if (totalMedia === 3) maxDisplay = 3;
              else if (totalMedia >= 6) maxDisplay = 6;

              const displayUrls =
                urls.slice(0, maxDisplay);

              displayUrls.forEach(
                (url, index) => {
                  if (!url) return;

                  const extra =
                    index === maxDisplay - 1 &&
                    totalMedia > maxDisplay
                      ? `<div class="grid-overlay">+${totalMedia - maxDisplay}</div>`
                      : '';

                  gridImages += `
                    <div class="grid-img-wrapper"
                      data-action="zoom"
                      data-post-id="${escapeHtml(post.id)}"
                      data-index="${index}">
                      <img
                        class="grid-img"
                        loading="${postIndex === 0 ? 'eager' : 'lazy'}"
                        decoding="async"
                        src="${escapeHtml(url)}">
                      ${extra}
                    </div>`;
                }
              );

              mediaHTML = `
                <div class="image-grid-container">
                  <div class="image-grid grid-${maxDisplay}">
                    ${gridImages}
                  </div>
                </div>`;
            } else {
              const url = urls[0];

              if (!url) {
                mediaHTML = '';
              } else if (
                post.media_type === 'reel'
              ) {
                mediaHTML = `
                  <div class="video-click-wrapper"
                    data-action="zoom"
                    data-post-id="${escapeHtml(post.id)}">
                    <video
                      src="${escapeHtml(url)}"
                      class="reel-feed-video"
                      autoplay loop muted playsinline
                      style="pointer-events:none;">
                    </video>
                  </div>`;
              } else if (
                post.media_type === 'video'
              ) {
                mediaHTML = `
                  <div class="video-click-wrapper"
                    data-action="zoom"
                    data-post-id="${escapeHtml(post.id)}">
                    <video
                      src="${escapeHtml(url)}"
                      class="normal-feed-video"
                      autoplay loop muted playsinline
                      style="pointer-events:none;">
                    </video>
                  </div>`;
              } else {
                mediaHTML = `
                  <img
                    src="${escapeHtml(url)}"
                    alt="Post"
                    loading="${postIndex === 0 ? 'eager' : 'lazy'}"
                    decoding="async"
                    data-action="zoom"
                    data-post-id="${escapeHtml(post.id)}"
                    style="width:100%;max-height:600px;object-fit:cover;cursor:pointer;">`;
              }
            }
          }

          let avatar = await getSignedUrl(
            post.profiles?.avatar_url
          );

          avatar = avatar || DEFAULT_AVATAR;

          const name =
            post.profiles?.full_name || 'User';

          const isMyPost =
            currentUser &&
            post.user_id === currentUser.id;

          const commentsCount =
            safeComments.length;

          const shortDesc =
            normalizeDisplayDescription(post.description);

          let descHTML = '';

          if (shortDesc.length > 200) {
            const truncated =
              Array.from(shortDesc).slice(0, 200).join('') + '...';

            descHTML = `<span class="desc-text" data-full="${escapeHtml(shortDesc)}" data-short="${escapeHtml(truncated)}">${escapeHtml(truncated)}</span> <button class="read-more-btn" data-action="toggle-description">more</button>`;
          } else if (shortDesc.length > 0) {
            descHTML = `<span class="desc-text">${escapeHtml(shortDesc)}</span>`;
          }

          // POST HTML

          const postHTML = `
            <div class="post-card"
              id="post-${escapeHtml(post.id)}">

              <div class="post-header">
                <img
                  src="${escapeHtml(avatar)}"
                  class="user-icon"
                  decoding="async">

                <h4>
                  ${escapeHtml(name)}
                  <span>${escapeHtml(formattedDate)}</span>
                </h4>

                ${isMyPost ? `
                  <div class="post-owner-actions">
                    <button class="post-options-btn"
                      title="Edit post"
                      data-action="edit-post"
                      data-post-id="${escapeHtml(post.id)}">
                      <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="post-options-btn"
                      title="Delete post"
                      data-action="delete-post"
                      data-post-id="${escapeHtml(post.id)}">
                      <i class="fa-solid fa-trash"></i>
                    </button>
                  </div>` : ''}
              </div>

              <div class="post-media">
                ${mediaHTML}
              </div>

              <div class="post-actions-bar">

                <button
                  class="like-btn post-action-btn ${isLiked ? 'liked' : ''}"
                  type="button"
                  aria-pressed="${isLiked}"
                  data-action="toggle-like"
                  data-post-id="${escapeHtml(post.id)}">
                  <span class="action-icon">
                    <i class="${isLiked ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                  </span>
                  <span class="action-label">Like</span>
                </button>

                <button
                  class="comment-btn post-action-btn"
                  type="button"
                  data-action="open-comments"
                  data-post-id="${escapeHtml(post.id)}">
                  <span class="action-icon">
                    <i class="fa-regular fa-comment"></i>
                  </span>
                  <span class="action-label">Comment</span>
                </button>
              </div>

              <div class="post-likes-count">
                ${safeLikes.length} Likes &bull;
                ${commentsCount} Comments
              </div>

              ${post.description ? `
                <div class="post-desc-container">
                  <strong class="post-author">
                    ${escapeHtml(name)}
                  </strong>
                  <div class="post-desc-content" dir="auto">
                    ${descHTML}
                  </div>
                </div>` : ''}
            </div>`;

          postsFeed.insertAdjacentHTML(
            'beforeend',
            postHTML
          );

          window.DugitalLoader?.hide();
        }

        if (!postsFeed.innerHTML) {
          postsFeed.innerHTML =
            '<div style="text-align:center;padding:40px;color:#888;">چو پۆست نەهاتینە دیتن...</div>';
        }
      } catch (error) {
        console.error('[Dugital] Feed request failed:', {
          code: error?.code || 'NETWORK_OR_TIMEOUT',
          message: error?.message || 'Unknown error',
          details: error?.details || '',
          hint: error?.hint || ''
        });

        postsFeed.innerHTML =
          '<div class="loading-state" role="alert">Could not load stories. <button class="retry-button" data-action="reload">Retry</button></div>';
      } finally {
        window.DugitalLoader?.hide();
      }
    }

    // READ MORE

    window.toggleInlineDesc = (
      button,
      event
    ) => {
      event?.stopPropagation();

      const textSpan =
        button.closest('.lightbox-caption')?.querySelector('.desc-text') ||
        button.previousElementSibling;

      if (!textSpan || !textSpan.classList.contains('desc-text')) return;

      const isCollapsed =
        button.innerText.trim().toLowerCase() !==
        'less';

      textSpan.textContent =
        textSpan.getAttribute(
          isCollapsed
            ? 'data-full'
            : 'data-short'
        ) || '';

      button.innerText =
        isCollapsed ? 'less' : 'more';

      button.setAttribute(
        'aria-expanded',
        String(isCollapsed)
      );

      const overlay =
        button.closest('.lightbox-info');

      if (overlay) {
        overlay.classList.toggle(
          'is-expanded',
          isCollapsed
        );
      }
    };

    // LIKES

    window.toggleLike = async (
      postId,
      button
    ) => {
      if (!currentUser) return;

      const currentlyLiked =
        button.classList.contains('liked');

      button.dataset.manuallyToggled = 'true';

      button.setAttribute(
        'aria-pressed',
        String(!currentlyLiked)
      );

      const card =
        button.closest('.post-card');

      const likesCountEl =
        card?.querySelector('.post-likes-count');

      const currentText =
        likesCountEl?.innerText || '';

      const likesPart =
        currentText.split('•')[0] || '0 Likes';

      const commentsPart =
        currentText.split('•')[1] ||
        '0 Comments';

      let likesNum =
        parseInt(
          likesPart.replace(/[^0-9]/g, '')
        ) || 0;

      if (currentlyLiked) {
        button.classList.remove('liked');

        button.querySelector(
          '.action-icon i'
        ).className =
          'fa-regular fa-heart';

        likesNum = Math.max(
          0,
          likesNum - 1
        );

        if (likesCountEl) {
          likesCountEl.textContent =
            `${likesNum} Likes • ${commentsPart.trim()}`;
        }

        const { error } = await supabase
          .from('likes')
          .delete()
          .match({
            post_id: postId,
            user_id: currentUser.id
          });

        if (error) {
          alert('Could not unlike: ' + error.message);
          location.reload();
          return;
        }

        if (isLikedPage) {
          document.getElementById(
            `post-${postId}`
          )?.remove();
        }
      } else {
        button.classList.add('liked');

        button.querySelector(
          '.action-icon i'
        ).className =
          'fa-solid fa-heart';

        likesNum++;

        if (likesCountEl) {
          likesCountEl.textContent =
            `${likesNum} Likes • ${commentsPart.trim()}`;
        }

        const { error } = await supabase
          .from('likes')
          .insert([{
            post_id: postId,
            user_id: currentUser.id
          }]);

        if (error) {
          alert('Could not like: ' + error.message);
          location.reload();
        }
      }
    };

    // EDIT POSTS

    const editModal =
      document.getElementById('edit-modal');

    const editInput =
      document.getElementById(
        'edit-post-desc'
      );

    const editError =
      document.getElementById(
        'edit-post-error'
      );

    const saveEditBtn =
      document.getElementById(
        'save-edit-btn'
      );

    let currentEditPostId = null;

    window.editPost = postId => {
      const post =
        window.currentLoadedPosts.find(
          item =>
            String(item.id) === String(postId)
        );

      if (
        !post ||
        !currentUser ||
        post.user_id !== currentUser.id
      ) {
        return;
      }

      currentEditPostId = post.id;

      editInput.value =
        post.description || '';

      editError.textContent = '';

      editModal?.classList.remove('hidden');

      editInput.focus();
    };

    document.getElementById(
      'cancel-edit-btn'
    )?.addEventListener('click', () => {
      editModal?.classList.add('hidden');
      currentEditPostId = null;
    });

    saveEditBtn?.addEventListener(
      'click',
      async () => {
        if (
          currentEditPostId === null ||
          !currentUser
        ) {
          return;
        }

        saveEditBtn.disabled = true;
        editError.textContent = '';

        try {
          const { data, error } = await supabase
            .from('posts')
            .update({
              description:
                editInput.value.trim()
            })
            .eq('id', currentEditPostId)
            .eq('user_id', currentUser.id)
            .select('id');

          if (error) throw error;

          if (!data?.length) {
            throw new Error(
              'Post was not updated.'
            );
          }

          editModal.classList.add('hidden');
          currentEditPostId = null;

          await loadPosts();
        } catch (error) {
          editError.textContent =
            error.message;
        } finally {
          saveEditBtn.disabled = false;
        }
      }
    );

    // DELETE POSTS

    const deleteModal =
      document.getElementById(
        'delete-modal'
      );

    window.confirmDelete = postId => {
      const post =
        window.currentLoadedPosts.find(
          item =>
            String(item.id) === String(postId)
        );

      if (
        !post ||
        !currentUser ||
        post.user_id !== currentUser.id
      ) {
        return;
      }

      currentDeletePostId = post.id;

      deleteModal?.classList.remove('hidden');
    };

    document.getElementById(
      'cancel-delete-btn'
    )?.addEventListener('click', () => {
      deleteModal?.classList.add('hidden');
      currentDeletePostId = null;
    });

    document.getElementById(
      'confirm-delete-btn'
    )?.addEventListener(
      'click',
      async () => {
        if (
          currentDeletePostId === null ||
          !currentUser
        ) {
          return;
        }

        const deleteBtn =
          document.getElementById(
            'confirm-delete-btn'
          );

        deleteBtn.disabled = true;

        try {
          const { data, error } = await supabase
            .from('posts')
            .delete()
            .eq('id', currentDeletePostId)
            .eq('user_id', currentUser.id)
            .select('id');

          if (error) throw error;

          if (!data?.length) {
            throw new Error(
              'Post was not deleted.'
            );
          }

          document.getElementById(
            `post-${currentDeletePostId}`
          )?.remove();

          window.currentLoadedPosts =
            window.currentLoadedPosts.filter(
              post =>
                String(post.id) !==
                String(currentDeletePostId)
            );

          deleteModal.classList.add('hidden');
          currentDeletePostId = null;
        } catch (error) {
          alert(
            'Delete failed: ' +
            error.message
          );
        } finally {
          deleteBtn.disabled = false;
        }
      }
    );

    // LIGHTBOX

    const lightbox =
      document.getElementById(
        'lightbox-modal'
      );

    const lightboxContainer =
      document.getElementById(
        'lightbox-content-container'
      );

    const infoOverlay =
      document.getElementById(
        'lightbox-info'
      );

    const closeLightboxBtn =
      document.getElementById(
        'close-lightbox-btn'
      );

    const sliderCounterTop =
      document.createElement('div');

    sliderCounterTop.className =
      'slider-counter hidden';

    sliderCounterTop.id =
      'zoom-slider-counter';

    lightbox.appendChild(sliderCounterTop);

    closeLightboxBtn?.addEventListener(
      'click',
      () => {
        lightbox.classList.add('hidden');

        infoOverlay.classList.remove(
          'is-expanded'
        );

        lightboxContainer.innerHTML = '';

        sliderCounterTop.classList.add(
          'hidden'
        );
      }
    );

    window.openZoom = async (
      postId,
      startIndex = 0
    ) => {
      const post =
        window.currentLoadedPosts.find(
          item =>
            String(item.id) === String(postId)
        );

      if (!post) return;

      infoOverlay.classList.remove(
        'is-expanded'
      );

      infoOverlay.classList.add('hidden');

      sliderCounterTop.classList.add(
        'hidden'
      );

      lightbox.classList.remove('hidden');

      lightboxContainer.innerHTML =
        '<div class="lightbox-media-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>';

      let avatar = await getSignedUrl(
        post.profiles?.avatar_url
      );

      avatar = avatar || DEFAULT_AVATAR;

      const name =
        post.profiles?.full_name || 'User';

      if (post.media_type === 'image') {
        const rawUrls = String(
          post.media_url || ''
        ).split(',').filter(Boolean);

        const urls = await Promise.all(
          rawUrls.map(getSignedUrl)
        );

        if (urls.length > 1) {
          const initialIndex = Math.max(
            0,
            Math.min(
              Number(startIndex) || 0,
              urls.length - 1
            )
          );

          sliderCounterTop.innerText =
            `${initialIndex + 1} / ${urls.length}`;

          sliderCounterTop.classList.remove(
            'hidden'
          );

          const slides = urls.map(
            (url, index) =>
              url
                ? `<img class="slider-img" src="${escapeHtml(url)}" loading="eager" decoding="async" alt="Image ${index + 1}">`
                : ''
          ).join('');

          lightboxContainer.innerHTML = `
            <div class="media-slider-container">
              <div class="media-slider">
                ${slides}
              </div>
            </div>`;

          const rail =
            lightboxContainer.querySelector(
              '.media-slider'
            );

          if (rail) {
            rail.addEventListener(
              'scroll',
              () => window.updateSliderCounter(
                rail,
                post.id,
                urls.length
              ),
              { passive: true }
            );

            if (initialIndex > 0) {
              rail.scrollLeft =
                rail.clientWidth *
                initialIndex;
            }
          }
        } else {
          lightboxContainer.innerHTML =
            urls[0]
              ? `<img src="${escapeHtml(urls[0])}" style="width:100%;max-height:85vh;object-fit:contain;">`
              : '<span>Media unavailable</span>';
        }
      } else {
        const videoClass =
          post.media_type === 'reel'
            ? 'zoom-reel-video'
            : 'zoom-normal-video';

        const url = await getSignedUrl(
          post.media_url
        );

        lightboxContainer.innerHTML = url
          ? `<video id="zoom-video" class="${videoClass}" src="${escapeHtml(url)}" autoplay loop playsinline></video>`
          : '<span>Media unavailable</span>';

        const video =
          document.getElementById(
            'zoom-video'
          );

        if (video) {
          video.addEventListener(
            'click',
            () => {
              if (video.paused) video.play();
              else video.pause();
            }
          );
        }
      }

      // The caption stays visible in the viewer even for long RTL text.
      const desc = normalizeDisplayDescription(post.description);
      const codepoints = Array.from(desc);
      const hasLongCaption = codepoints.length > 180;
      const preview = hasLongCaption
        ? codepoints.slice(0, 180).join('').trimEnd() + '…'
        : desc;

      infoOverlay.classList.add('dugital-caption-fixed');
      infoOverlay.innerHTML = `
        <div class="lightbox-user">
          <img src="${escapeHtml(avatar)}" alt="">
          <strong>${escapeHtml(name)}</strong>
        </div>
        ${desc ? `
          <div class="lightbox-caption">
            <div class="lightbox-description-scroll">
              <div class="lightbox-desc" dir="auto">
                <span class="desc-text"
                  data-full="${escapeHtml(desc)}"
                  data-short="${escapeHtml(preview)}">${escapeHtml(preview)}</span>
              </div>
            </div>
            ${hasLongCaption ? `
              <button class="read-more-btn" type="button"
                data-action="toggle-description" aria-expanded="false">more</button>
            ` : ''}
          </div>` : ''}`;

      infoOverlay.classList.remove('hidden');
    };

    // COMMENTS

    const commentsModal =
      document.getElementById(
        'comments-modal'
      );

    const closeComments = () => {
      commentsModal?.classList.add(
        'hidden'
      );
    };

    document.getElementById(
      'close-comments-icon'
    )?.addEventListener(
      'click',
      closeComments
    );

    commentsModal?.addEventListener(
      'click',
      event => {
        if (event.target === commentsModal) {
          closeComments();
        }
      }
    );

    window.openComments = async postId => {
      window.currentCommentPostId = postId;

      commentsModal.classList.remove(
        'hidden'
      );

      await renderComments(postId);
    };

    async function renderComments(postId) {
      const list =
        document.getElementById(
          'comments-list'
        );

      const { data, error } = await supabase
        .from('comments')
        .select(
          '*, profiles:user_id(full_name, avatar_url)'
        )
        .eq('post_id', postId)
        .order('created_at', {
          ascending: true
        });

      if (error) {
        list.textContent =
          'Could not load comments.';
        return;
      }

      const html = await Promise.all(
        (data || []).map(async comment => {
          let avatar = await getSignedUrl(
            comment.profiles?.avatar_url
          );

          avatar = avatar || DEFAULT_AVATAR;

          return `
            <div class="comment-item" dir="auto">
              <img src="${escapeHtml(avatar)}">
              <div class="comment-text-box">
                <strong>${escapeHtml(comment.profiles?.full_name || 'User')}</strong>
                ${escapeHtml(comment.comment_text)}
              </div>
            </div>`;
        })
      );

      list.innerHTML = html.join('');
    }

    document.getElementById(
      'send-comment-btn'
    )?.addEventListener(
      'click',
      async () => {
        const input =
          document.getElementById(
            'comment-input'
          );

        if (
          !input?.value.trim() ||
          !currentUser
        ) {
          return;
        }

        const { error } = await supabase
          .from('comments')
          .insert([{
            post_id:
              window.currentCommentPostId,
            user_id:
              currentUser.id,
            comment_text:
              input.value
          }]);

        if (error) {
          alert(
            'Comment failed: ' +
            error.message
          );
          return;
        }

        input.value = '';

        await renderComments(
          window.currentCommentPostId
        );

        await loadPosts();
      }
    );

    loadPosts();
  }

  // UPLOAD PAGE

  if (isUploadPage) {
    window.DugitalLoader?.hide();

    const fileInput =
      document.getElementById(
        'post-file'
      );

    const previewContainer =
      document.getElementById(
        'preview-container'
      );

    const pubBtn =
      document.getElementById(
        'publish-btn'
      );

    window.selectedUploadType = 'image';

    const typeBtns =
      document.querySelectorAll(
        '.upload-type-btn'
      );

    typeBtns.forEach(button => {
      button.addEventListener(
        'click',
        () => {
          typeBtns.forEach(item =>
            item.classList.remove('active')
          );

          button.classList.add('active');

          window.selectedUploadType =
            button.getAttribute(
              'data-type'
            );

          if (
            window.selectedUploadType ===
            'image'
          ) {
            fileInput.accept = 'image/*';
            fileInput.multiple = true;
          } else {
            fileInput.accept = 'video/*';
            fileInput.multiple = false;
          }

          fileInput.click();
        }
      );
    });

    let selectedFiles = [];
    let previewUrl = null;

    fileInput?.addEventListener(
      'change',
      event => {
        selectedFiles = Array.from(
          event.target.files
        ).slice(0, 20);

        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          previewUrl = null;
        }

        if (!selectedFiles.length) return;

        const file = selectedFiles[0];

        previewUrl =
          URL.createObjectURL(file);

        if (file.type.startsWith('video/')) {
          previewContainer.innerHTML = `
            <video
              class="video-preview"
              src="${escapeHtml(previewUrl)}"
              muted autoplay loop>
            </video>`;
        } else {
          previewContainer.innerHTML = `
            <img
              class="image-preview"
              src="${escapeHtml(previewUrl)}"
              alt="Preview">`;

          if (selectedFiles.length > 1) {
            previewContainer.innerHTML += `
              <div class="multiple-badge">
                +${selectedFiles.length - 1}
              </div>`;
          }
        }

        previewContainer.classList.remove(
          'hidden'
        );
      }
    );

    // PUBLISH POST

    pubBtn?.addEventListener(
      'click',
      async () => {
        if (!currentUser) return;

        const desc =
          document.getElementById(
            'post-desc'
          )?.value || '';

        const filesToUpload =
          selectedFiles.length > 0
            ? selectedFiles
            : Array.from(
                fileInput?.files || []
              ).slice(0, 20);

        if (
          !desc.trim() &&
          filesToUpload.length === 0
        ) {
          alert(
            'Write something or select a file.'
          );
          return;
        }

        pubBtn.innerHTML =
          '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...';

        pubBtn.disabled = true;

        window.DugitalLoader?.show(
          'Publishing your story...'
        );

        try {
          const mediaUrls = [];
          let mediaType = 'image';

          for (
            let i = 0;
            i < filesToUpload.length;
            i++
          ) {
            const file = filesToUpload[i];
            const ext = uploadExt(file);

            if (!ext) {
              throw new Error(
                'Unsupported file type.'
              );
            }

            const limit =
              file.type.startsWith('video/')
                ? 150 * 1024 * 1024
                : 15 * 1024 * 1024;

            if (file.size > limit) {
              throw new Error(
                'File is too large.'
              );
            }

            const filePath =
              `${currentUser.id}/${crypto.randomUUID()}_${i}.${ext}`;

            const { error } =
              await supabase.storage
                .from(MEDIA_BUCKET)
                .upload(
                  filePath,
                  file,
                  {
                    cacheControl: '3600',
                    upsert: false
                  }
                );

            if (error) throw error;

            mediaUrls.push(filePath);
          }

          if (filesToUpload.length > 0) {
            mediaType =
              filesToUpload[0].type.startsWith(
                'video/'
              )
                ? (
                    window.selectedUploadType ===
                    'reel'
                      ? 'reel'
                      : 'video'
                  )
                : 'image';
          }

          const finalMediaUrl =
            mediaUrls.length
              ? mediaUrls.join(',')
              : null;

          const { error: postError } =
            await supabase
              .from('posts')
              .insert([{
                user_id: currentUser.id,
                description: desc,
                media_url: finalMediaUrl,
                media_type: mediaType
              }]);

          if (postError) throw postError;

          window.location.href =
            'home.html';
        } catch (error) {
          pubBtn.innerHTML =
            '<i class="fa-solid fa-paper-plane"></i>';

          pubBtn.disabled = false;

          window.DugitalLoader?.hide();

          alert(
            'Error uploading: ' +
            error.message
          );
        }
      }
    );
  }

  // PROFILE PAGE

  if (isProfilePage) {
    await profilePromise;

    if (currentProfile) {
      const nameDisplay =
        document.getElementById(
          'profile-name-display'
        );

      if (nameDisplay) {
        nameDisplay.textContent =
          currentProfile.full_name || 'User';
      }

      if (currentProfile.avatar_url) {
        const avatar = await getSignedUrl(
          currentProfile.avatar_url
        );

        const preview =
          document.getElementById(
            'profile-img-preview'
          );

        if (avatar && preview) {
          preview.src = avatar;
        }
      }
    }

    try {
      const { data } = await withTimeout(
        supabase
          .from('posts')
          .select('id')
          .eq('user_id', currentUser.id),
        12000,
        'Profile posts'
      );

      const count =
        document.getElementById(
          'user-post-count'
        );

      if (count && data) {
        count.textContent =
          String(data.length);
      }
    } catch (error) {
      console.warn(
        'Profile posts failed:',
        error
      );
    }

    window.DugitalLoader?.hide();

    // LOGOUT

    document.getElementById(
      'logout-btn'
    )?.addEventListener(
      'click',
      async () => {
        await supabase.auth.signOut();
        window.location.href =
          'index.html';
      }
    );

    // AVATAR UPLOAD

    document.getElementById(
      'profile-upload'
    )?.addEventListener(
      'change',
      async event => {
        const file =
          event.target.files?.[0];

        if (!file || !currentUser) return;

        const spinner =
          document.getElementById(
            'upload-spinner'
          );

        spinner?.classList.remove(
          'hidden'
        );

        try {
          const ext = uploadExt(file);

          if (
            !ext ||
            !file.type.startsWith('image/')
          ) {
            throw new Error(
              'Use a JPG, PNG, WEBP or GIF avatar.'
            );
          }

          if (
            file.size > 5 * 1024 * 1024
          ) {
            throw new Error(
              'Avatar must be 5MB or smaller.'
            );
          }

          // New secure avatar path
          const filePath =
            `${currentUser.id}/avatars/${crypto.randomUUID()}.${ext}`;

          const { error: uploadError } =
            await supabase.storage
              .from(MEDIA_BUCKET)
              .upload(
                filePath,
                file,
                { upsert: false }
              );

          if (uploadError) {
            throw uploadError;
          }

          const { error: profileError } =
            await supabase
              .from('profiles')
              .update({
                avatar_url: filePath
              })
              .eq('id', currentUser.id);

          if (profileError) {
            throw profileError;
          }

          const avatar =
            await getSignedUrl(filePath);

          const preview =
            document.getElementById(
              'profile-img-preview'
            );

          if (avatar && preview) {
            preview.src = avatar;
          }
        } catch (error) {
          alert(
            'Error updating profile picture: ' +
            error.message
          );
        } finally {
          spinner?.classList.add(
            'hidden'
          );
        }
      }
    );
  }
});
