
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const supabaseUrl = 'https://vycidctybcihudvuydwj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5Y2lkY3R5YmNpaHVkdnV5ZHdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NDE5MjMsImV4cCI6MjEwNjAxNzkyM30.WtaUyVNEBdSmodPCNFGM9X_ArW07QcemmyQIGQeLmyg';
const supabase = createClient(supabaseUrl, supabaseKey);

let currentUser = null;
let currentProfile = null;


function withTimeout(task, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(task),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out. Check your connection and retry.')), ms); })
  ]).finally(() => clearTimeout(timer));
}

const signedUrlCache = new Map();

window.currentCommentPostId = null;
let currentDeletePostId = null;
window.currentLoadedPosts = [];

const escapeHtml = (t) => {
  if (!t) return '';
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
};



async function getSignedUrl(url) {
  if (!url) return null;
  const input = String(url).trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  const path = input.replace(/^\/+/, '');
  if (signedUrlCache.has(path)) return signedUrlCache.get(path);
  const promise = (async () => {
    try {
      const { data, error } = await withTimeout(
        supabase.storage.from('media').createSignedUrl(path, 60 * 60 * 24),
        6500, 'Media link'
      );
      if (!error && data?.signedUrl) return data.signedUrl;
      if (error) console.warn('Signing unavailable for media:', error.message);
    } catch (err) {
      console.warn('Media URL request was slow:', err.message);
    }
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
  })();
  signedUrlCache.set(path, promise);
  return promise;
}


const mediaRetries = new WeakMap();
const storagePathOf = (url) => {
  const match = String(url || '').match(/\/storage\/v1\/object\/(?:public|sign)\/media\/([^?]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
};
const showMediaError = (element) => {
  element.style.display = 'none';
  const parent = element.parentElement;
  if (!parent || parent.querySelector('.media-error-message')) return;
  parent.classList.add('media-has-error');
  const hint = document.createElement('div');
  hint.className = 'media-error-message';
  hint.innerHTML = '<i class="fa-regular fa-image" aria-hidden="true"></i><span>Image unavailable</span>';
  parent.appendChild(hint);
};
document.addEventListener('load', (event) => {
  const el = event.target;
  if (el instanceof HTMLImageElement && mediaRetries.has(el)) {
    el.style.opacity = '';
    el.style.display = '';
  }
}, true);
document.addEventListener('error', async (event) => {
  const el = event.target;
  if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLVideoElement)) return;
  const prior = mediaRetries.get(el) || 0;
  if (prior > 0) { if (el instanceof HTMLImageElement) showMediaError(el); return; }
  mediaRetries.set(el, 1);
  const url = el.currentSrc || el.src;
  const path = storagePathOf(url);
  if (!path) { if (el instanceof HTMLImageElement) showMediaError(el); return; }
  try {
    const isSigned = /\/storage\/v1\/object\/sign\/media\//.test(url);
    let alternate;
    if (isSigned) {
      alternate = supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
    } else {
      const { data, error } = await withTimeout(
        supabase.storage.from('media').createSignedUrl(path, 60 * 60 * 24),
        6500, 'Media retry'
      );
      if (error) throw error;
      alternate = data?.signedUrl;
    }
    if (alternate && el.isConnected && alternate !== url) {
      el.src = alternate;
      return;
    }
  } catch (err) { console.warn('Media fallback failed:', err.message); }
  if (el instanceof HTMLImageElement) showMediaError(el);
}, true);

document.addEventListener('DOMContentLoaded', async () => {

  const currentPageStr = window.location.pathname.split('/').pop().toLowerCase();
  const isIndexPage = currentPageStr === '' || currentPageStr.includes('index');
  const isHomePage = currentPageStr.includes('home');
  const isLikedPage = currentPageStr.includes('liked');
  const isUploadPage = currentPageStr.includes('upload');
  const isProfilePage = currentPageStr.includes('profile');

  // Keep the branded loading screen until session and necessary data resolve.
  window.DugitalLoader?.show(isIndexPage ? 'Connecting to Dugital...' : 'Loading your space...');
  let session;
  try {
    const result = await withTimeout(supabase.auth.getSession(), 12000, 'Session check');
    if (result.error) throw result.error;
    session = result.data.session;
  } catch (err) {
    window.DugitalLoader?.hide();
    document.getElementById('auth-error')?.replaceChildren(document.createTextNode(err.message || 'Could not connect. Please refresh.'));
    if (!isIndexPage) {
      const feed = document.getElementById('posts-feed');
      if (feed) feed.innerHTML = '<div class="loading-state" role="alert">Could not verify your session. <button class="retry-button" onclick="location.reload()">Retry</button></div>';
      else window.DugitalLoader?.fail('Could not check your session. Please retry.');
    }
    return;
  }

  if (!session && !isIndexPage) {
    window.location.href = 'index.html'; return;
  }
  if (session && isIndexPage) {
    window.location.href = 'home.html'; return;
  }


  let profilePromise = Promise.resolve(null);
  if (session) {
    currentUser = session.user;
    profilePromise = withTimeout(
      supabase.from('profiles').select('*').eq('id', currentUser.id).single(),
      8500, 'Profile request'
    ).then(result => {
      if (result.error) throw result.error;
      currentProfile = result.data;
      return result.data;
    }).catch(err => {
      console.warn('Profile could not be loaded:', err.message);
      return null;
    });
  }

  let lastScroll = 0;
  window.addEventListener('scroll', () => {
    const header = document.getElementById('main-header');
    if (!header) return;
    const currentScroll = window.pageYOffset;
    if (currentScroll > lastScroll && currentScroll > 50) {
      
    } else {
     
    }
    lastScroll = currentScroll;
  });

  if (isIndexPage) {
    window.DugitalLoader?.hide();
    const emailInput = document.getElementById('email');
    const passInput = document.getElementById('password');
    const loginBtn = document.getElementById('login-btn');

    emailInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') passInput.focus();
    });
    passInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') loginBtn.click();
    });

    loginBtn?.addEventListener('click', async () => {
      if (loginBtn.disabled) return;
      const errorNode = document.getElementById('auth-error');
      if (errorNode) errorNode.textContent = '';
      if (!emailInput.value.trim() || !passInput.value) {
        if (errorNode) errorNode.textContent = 'Enter your email and password.';
        return;
      }
      loginBtn.disabled = true;
      window.DugitalLoader?.show('Signing you in...');
      try {
        const { error } = await withTimeout(supabase.auth.signInWithPassword({ email: emailInput.value.trim(), password: passInput.value }), 18000, 'Sign in');
        if (error) throw error;
        window.DugitalLoader?.show('Preparing your news feed...');
        window.location.href = 'home.html';
      } catch (err) {
        if (errorNode) errorNode.textContent = err.message || 'Could not sign in.';
        window.DugitalLoader?.hide();
        loginBtn.disabled = false;
      }
    });

    document.getElementById('signup-btn')?.addEventListener('click', async () => {
      const { error } = await supabase.auth.signUp({ email: emailInput.value, password: passInput.value });
      if (error) document.getElementById('auth-error').innerText = error.message;
      else alert('Account created! Please Sign In.');
    });
  }

  if (isHomePage || isLikedPage) {
    const postsFeed = document.getElementById('posts-feed');

    window.updateSliderCounter = (el, postId, total) => {
      const scrollLeft = el.scrollLeft;
      const width = el.clientWidth;
      const currentIndex = Math.round(scrollLeft / width) + 1;
      const counterEl = document.getElementById('zoom-slider-counter');
      if (counterEl) counterEl.innerText = `${currentIndex} / ${total}`;
    };

    async function loadPosts() {
      window.DugitalLoader?.show('Loading the latest stories...');
      try {
        let myLikedIds = [];
        const postsRequest = withTimeout(
          supabase.from('posts')
            .select(`*, profiles:user_id(full_name, avatar_url), likes(user_id), comments(id)`)
            .order('created_at', { ascending: false }),
          16000, 'Posts request'
        );
        const likesRequest = currentUser
          ? withTimeout(
            supabase.from('likes').select('post_id').eq('user_id', currentUser.id),
            9000, 'Likes request'
          ).catch(err => {
            console.warn('Could not load likes:', err.message);
            return { data: [] };
          })
          : Promise.resolve({ data: [] });
        const { data: posts, error: postsError } = await postsRequest;
        if (postsError) throw postsError;
        if (isLikedPage) {
          const { data: likesData } = await likesRequest;
          myLikedIds = (likesData || []).map(l => String(l.post_id));
        } else {
          // Home stories must not wait for a second independent query.
          likesRequest.then(({ data: likesData }) => {
            const ids = new Set((likesData || []).map(l => String(l.post_id)));
            document.querySelectorAll('.post-action-btn.like-btn').forEach(btn => {
              const id = btn.getAttribute('data-post-id');
              if (btn.dataset.manuallyToggled === 'true') return;
              const liked = ids.has(id);
              btn.classList.toggle('liked', liked);
              const heart = btn.querySelector('.action-icon i');
              if (heart) heart.className = (liked ? 'fa-solid' : 'fa-regular') + ' fa-heart';
              btn.setAttribute('aria-pressed', String(liked));
            });
          }).catch(err => console.warn('Could not update likes:', err));
        }

        if (!posts) throw new Error("No data returned from Supabase.");
        if (posts) {
          window.currentLoadedPosts = posts;
          postsFeed.innerHTML = '';

          if (isLikedPage && myLikedIds.length === 0) {
            postsFeed.innerHTML = '<p style="text-align:center; margin-top: 50px; color: #888; font-family: Poppins;">چو پۆست نەهاتینە لایك كرن...</p>';
            return;
          }

          for (const [postIndex, post] of posts.entries()) {
            const safeLikes = Array.isArray(post.likes) ? post.likes : [];
            const safeComments = Array.isArray(post.comments) ? post.comments : [];

            const isLiked = myLikedIds.includes(String(post.id));

            if (isLikedPage && !isLiked) continue;

            const postDate = new Date(post.created_at);
            const day = postDate.getDate();
            const month = postDate.getMonth() + 1;
            const year = postDate.getFullYear();
            const time = postDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const formattedDate = `${day}/${month}/${year} ${time}`;

            let mediaHTML = '';
            if (post.media_url) {
              const rawUrls = post.media_url.split(',').filter(Boolean);
              const totalMedia = rawUrls.length;
              const displayLimit = post.media_type === 'image'
                ? (totalMedia === 3 ? 3 : totalMedia === 2 ? 2 : totalMedia >= 6 ? 6 : 4)
                : 1;
              const urls = await Promise.all(rawUrls.slice(0, displayLimit).map(getSignedUrl));

              if (post.media_type === 'image' && totalMedia > 1) {
                let gridImages = '';
                let maxDisplay = 4;
                if (totalMedia === 2) maxDisplay = 2;
                else if (totalMedia === 3) maxDisplay = 3;
                else if (totalMedia === 4 || totalMedia === 5) maxDisplay = 4;
                else if (totalMedia >= 6) maxDisplay = 6;

                const displayUrls = urls.slice(0, maxDisplay);

                displayUrls.forEach((url, index) => {
                  if (index === (maxDisplay - 1) && totalMedia > maxDisplay) {
                    const extraCount = totalMedia - maxDisplay;
                    gridImages += `<div class="grid-img-wrapper" onclick="window.openZoom('${post.id}', ${index})"><img class="grid-img" loading="${postIndex === 0 ? 'eager' : 'lazy'}" decoding="async" src="${url}"><div class="grid-overlay">+${extraCount}</div></div>`;
                  } else {
                    gridImages += `<div class="grid-img-wrapper" onclick="window.openZoom('${post.id}', ${index})"><img class="grid-img" loading="${postIndex === 0 ? 'eager' : 'lazy'}" decoding="async" src="${url}"></div>`;
                  }
                });

                mediaHTML = `
                                <div class="image-grid-container">
                                    <div class="image-grid grid-${maxDisplay}">
                                        ${gridImages}
                                    </div>
                                </div>
                            `;
              } else {
                const url = urls[0];
                if (post.media_type === 'reel') {
                  mediaHTML = `
                                    <div class="video-click-wrapper" onclick="window.openZoom('${post.id}')">
                                        <video src="${url}" class="reel-feed-video" autoplay loop muted playsinline style="pointer-events: none;"></video>
                                    </div>
                                `;
                } else if (post.media_type === 'video') {
                  mediaHTML = `
                                    <div class="video-click-wrapper" onclick="window.openZoom('${post.id}')">
                                        <video src="${url}" class="normal-feed-video" autoplay loop muted playsinline style="pointer-events: none;"></video>
                                    </div>
                                `;
                } else {
                  mediaHTML = `<img src="${url}" alt="Post" loading="${postIndex === 0 ? 'eager' : 'lazy'}" decoding="async" onclick="window.openZoom('${post.id}')" style="width: 100%; max-height: 600px; object-fit: cover; cursor: pointer;">`;
                }
              }
            }

            let avatar = await getSignedUrl(post.profiles?.avatar_url);
            avatar = avatar || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
            const name = post.profiles?.full_name || 'User';
            const isMyPost = currentUser && post.user_id === currentUser.id;
            const commentsCount = safeComments.length;

            let shortDesc = (post.description || '').trim();
            let descHTML = '';
            if (shortDesc.length > 200) {
              let truncated = shortDesc.substring(0, 200) + '...';
              descHTML = `<span class="desc-text" data-full="${escapeHtml(shortDesc)}" data-short="${escapeHtml(truncated)}">${escapeHtml(truncated)}</span><button class="read-more-btn" onclick="window.toggleInlineDesc(this, event)">more</button>`;
            } else if (shortDesc.length > 0) {
              descHTML = `<span class="desc-text">${escapeHtml(shortDesc)}</span>`;
            }

            const postHTML = `
                        <div class="post-card" id="post-${post.id}">
                            <div class="post-header">
                                <img src="${avatar}" class="user-icon" decoding="async">
                                <h4>${escapeHtml(name)} <span>${formattedDate}</span></h4>
                                ${isMyPost ? `<div class="post-owner-actions"><button class="post-options-btn" title="Edit post" onclick="window.editPost('${post.id}')"><i class="fa-solid fa-pen"></i></button><button class="post-options-btn" title="Delete post" onclick="window.confirmDelete('${post.id}')"><i class="fa-solid fa-trash"></i></button></div>` : ''}
                            </div>
                            
                            <div class="post-media">${mediaHTML}</div>
                            
                            <div class="post-actions-bar">
                                <button class="like-btn post-action-btn ${isLiked ? 'liked' : ''}" data-post-id="${post.id}" type="button" aria-pressed="${isLiked}" aria-label="Like post" onclick="window.toggleLike('${post.id}', this)">
                                    <span class="action-icon"><i class="${isLiked ? 'fa-solid' : 'fa-regular'} fa-heart"></i></span>
                                    <span class="action-label">Like</span>
                                </button>
                                <button class="comment-btn post-action-btn" type="button" aria-label="Open comments" onclick="window.openComments('${post.id}')">
                                    <span class="action-icon"><i class="fa-regular fa-comment"></i></span>
                                    <span class="action-label">Comment</span>
                                </button>
                            </div>
                            
                            <div class="post-likes-count">${safeLikes.length} Likes &bull; ${commentsCount} Comments</div>
                            
                            ${post.description ? `
                                <div class="post-desc-container">
                                    <strong class="post-author">${escapeHtml(name)}</strong>
                                    <div class="post-desc-content" dir="auto">${descHTML}</div>
                                </div>
                            ` : ''}
                        </div>
                    `;
            postsFeed.insertAdjacentHTML('beforeend', postHTML);
            
            window.DugitalLoader?.hide();
          }

          if (postsFeed.innerHTML === '') {
            postsFeed.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: #888;">چو پۆست نەهاتینە دیتن...</div>';
          }
        }
      } catch (err) {
        console.error('Could not load posts:', err);
        postsFeed.innerHTML = `<div class="loading-state" role="alert">Couldn't load stories. Check your connection and <button type="button" class="retry-button" onclick="location.reload()">try again</button>.</div>`;
      } finally {
        window.DugitalLoader?.hide();
      }
    }

    window.toggleInlineDesc = (btn, event) => {
      if (event) event.stopPropagation();
      const textSpan = btn.previousElementSibling;
      if (!textSpan) return;
      const isCollapsed = btn.innerText.trim().toLowerCase() !== 'less';
      textSpan.textContent = textSpan.getAttribute(isCollapsed ? 'data-full' : 'data-short') || '';
      btn.innerText = isCollapsed ? 'less' : 'more';
      btn.setAttribute('aria-expanded', String(isCollapsed));
      const overlay = btn.closest('.lightbox-info');
      if (overlay) {
        overlay.classList.toggle('is-expanded', isCollapsed);
        const detail = overlay.querySelector('.lightbox-description-scroll');
        if (detail && isCollapsed) detail.scrollTop = 0;
      }
    };

    window.toggleLike = async (postId, btnElement) => {
      const currentlyLiked = btnElement.classList.contains('liked');
      btnElement.dataset.manuallyToggled = 'true';
      btnElement.setAttribute('aria-pressed', String(!currentlyLiked));
      const card = btnElement.closest('.post-card');
      const likesCountEl = card.querySelector('.post-likes-count');

      let currentText = likesCountEl.innerText || "";
      let likesPart = currentText.split('•')[0] || "0 Likes";
      let commentsPart = currentText.split('•')[1] || "0 Comments";
      let likesNum = parseInt(likesPart.replace(/[^0-9]/g, '')) || 0;

      if (currentlyLiked) {
        btnElement.classList.remove('liked');
        btnElement.querySelector('.action-icon i').className = 'fa-regular fa-heart';

        likesNum = Math.max(0, likesNum - 1);
        likesCountEl.innerHTML = `${likesNum} Likes &bull; ${commentsPart.trim()}`;

        const { error } = await supabase.from('likes').delete().match({ post_id: postId, user_id: currentUser.id });
        if (error) { alert('Could not unlike: ' + error.message); location.reload(); return; }
        if (isLikedPage) {
          document.getElementById(`post-${postId}`)?.remove();
        }
      } else {
        btnElement.classList.add('liked');
        btnElement.querySelector('.action-icon i').className = 'fa-solid fa-heart';

        likesNum += 1;
        likesCountEl.innerHTML = `${likesNum} Likes &bull; ${commentsPart.trim()}`;

        const { error } = await supabase.from('likes').insert([{ post_id: postId, user_id: currentUser.id }]);
        if (error) { alert('Could not like: ' + error.message); location.reload(); return; }
      }
    }

    // Edit only the current user's posts; no database schema changes.
    const editModal = document.getElementById('edit-modal');
    const editInput = document.getElementById('edit-post-desc');
    const editError = document.getElementById('edit-post-error');
    const saveEditBtn = document.getElementById('save-edit-btn');
    let currentEditPostId = null;

    window.editPost = (postId) => {
      const post = window.currentLoadedPosts.find(p => String(p.id) === String(postId));
      if (!post || !currentUser || post.user_id !== currentUser.id) return;
      currentEditPostId = post.id;
      editInput.value = post.description || '';
      editError.textContent = '';
      editModal?.classList.remove('hidden');
      editInput.focus();
    };
    document.getElementById('cancel-edit-btn')?.addEventListener('click', () => {
      editModal?.classList.add('hidden');
      currentEditPostId = null;
    });
    saveEditBtn?.addEventListener('click', async () => {
      if (currentEditPostId === null || !currentUser) return;
      saveEditBtn.disabled = true;
      editError.textContent = '';
      try {
        const { data, error } = await supabase.from('posts')
          .update({ description: editInput.value.trim() })
          .eq('id', currentEditPostId)
          .eq('user_id', currentUser.id)
          .select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('Post was not updated. Check your database permissions.');
        editModal.classList.add('hidden');
        currentEditPostId = null;
        await loadPosts();
      } catch (err) {
        editError.textContent = err.message || 'Could not update this post.';
      } finally {
        saveEditBtn.disabled = false;
      }
    });

    const deleteModal = document.getElementById('delete-modal');
    window.confirmDelete = (postId) => {
      const post = window.currentLoadedPosts.find(p => String(p.id) === String(postId));
      if (!post || !currentUser || post.user_id !== currentUser.id) return;
      currentDeletePostId = post.id;
      deleteModal?.classList.remove('hidden');
    };
    document.getElementById('cancel-delete-btn')?.addEventListener('click', () => {
      deleteModal?.classList.add('hidden');
      currentDeletePostId = null;
    });
    document.getElementById('confirm-delete-btn')?.addEventListener('click', async () => {
      if (currentDeletePostId === null || !currentUser) return;
      const deleteBtn = document.getElementById('confirm-delete-btn');
      deleteBtn.disabled = true;
      try {
        const { data, error } = await supabase.from('posts')
          .delete()
          .eq('id', currentDeletePostId)
          .eq('user_id', currentUser.id)
          .select('id');
        if (error) throw error;
        if (!data?.length) throw new Error('Post was not deleted. Check your database permissions.');
        document.getElementById(`post-${currentDeletePostId}`)?.remove();
        window.currentLoadedPosts = window.currentLoadedPosts.filter(p => String(p.id) !== String(currentDeletePostId));
        deleteModal.classList.add('hidden');
        currentDeletePostId = null;
      } catch (err) {
        alert('Delete failed: ' + (err.message || 'Unknown error'));
      } finally {
        deleteBtn.disabled = false;
      }
    });

    const lightbox = document.getElementById('lightbox-modal');
    const lightboxContainer = document.getElementById('lightbox-content-container');
    const infoOverlay = document.getElementById('lightbox-info');
    const closeLightboxBtn = document.getElementById('close-lightbox-btn');

    const sliderCounterTop = document.createElement('div');
    sliderCounterTop.className = 'slider-counter hidden';
    sliderCounterTop.id = 'zoom-slider-counter';
    lightbox.appendChild(sliderCounterTop);

    closeLightboxBtn?.addEventListener('click', () => {
      lightbox.classList.add('hidden');
      infoOverlay.classList.remove('is-expanded');
      lightboxContainer.innerHTML = '';
      sliderCounterTop.classList.add('hidden');
      closeLightboxBtn.style.zIndex = '20010';
    });

    window.openZoom = async (postId, startIndex = 0) => {
      const post = window.currentLoadedPosts.find(p => String(p.id) === String(postId));
      if (!post) return;
      infoOverlay.classList.remove('is-expanded');
      infoOverlay.classList.add('hidden');
      sliderCounterTop.classList.add('hidden');
      
      lightbox.classList.remove('hidden');
      lightboxContainer.innerHTML = '<div class="lightbox-media-loading" aria-label="Loading image"><i class="fa-solid fa-spinner fa-spin"></i></div>';

      let av = await getSignedUrl(post.profiles?.avatar_url);
      av = av || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
      const name = post.profiles?.full_name || 'User';

      if (post.media_type === 'image') {
        const rawUrls = post.media_url.split(',').filter(Boolean);
        const urls = await Promise.all(rawUrls.map(getSignedUrl));

        if (urls.length > 1) {
          const initialIndex = Math.max(0, Math.min(Number(startIndex) || 0, urls.length - 1));
          sliderCounterTop.innerText = `${initialIndex + 1} / ${urls.length}`;
          sliderCounterTop.classList.remove('hidden');
          closeLightboxBtn.style.zIndex = '20030';

          let slides = urls.map((url, idx) => `<img class="slider-img" src="${url}" loading="eager" decoding="async" alt="Image ${idx + 1}">`).join('');
          lightboxContainer.innerHTML = `
                        <div class="media-slider-container">
                            <div class="media-slider" onscroll="window.updateSliderCounter(this, '${post.id}', ${urls.length})">
                                ${slides}
                            </div>
                        </div>
                    `;
         
          const rail = lightboxContainer.querySelector('.media-slider');
          if (rail && initialIndex > 0) rail.scrollLeft = rail.clientWidth * initialIndex;
        } else {
          lightboxContainer.innerHTML = `<img src="${urls[0]}" style="width: 100%; max-height: 85vh; object-fit: contain;">`;
        }
      } else {
        const vidClass = post.media_type === 'reel' ? 'zoom-reel-video' : 'zoom-normal-video';
        const signedVidUrl = await getSignedUrl(post.media_url);
        lightboxContainer.innerHTML = `<video id="zoom-video" class="${vidClass}" src="${signedVidUrl}" autoplay loop playsinline></video>`;

        setTimeout(() => {
          const vid = document.getElementById('zoom-video');
          if (vid) {
            vid.onclick = () => {
              if (vid.paused) vid.play();
              else vid.pause();
            };
          }
        }, 100);
      }

      const shortDescZoom = (post.description || '').trim();
      let zoomDescHTML = '';
      const codepoints = Array.from(shortDescZoom); 
      if (codepoints.length > 30) {
        const preview = codepoints.slice(0, 30).join('').trimEnd() + '…';
        zoomDescHTML = `<span class="desc-text" data-full="${escapeHtml(shortDescZoom)}" data-short="${escapeHtml(preview)}">${escapeHtml(preview)}</span><button type="button" class="read-more-btn" aria-expanded="false" onclick="window.toggleInlineDesc(this, event)">more</button>`;
      } else if (codepoints.length > 0) {
        zoomDescHTML = `<span class="desc-text">${escapeHtml(shortDescZoom)}</span>`;
      }

      infoOverlay.innerHTML = `
                <div class="lightbox-user"><img src="${av}"><strong>${escapeHtml(name)}</strong></div>
                ${zoomDescHTML ? `<div class="lightbox-description-scroll"><div class="lightbox-desc" dir="auto">${zoomDescHTML}</div></div>` : ''}
            `;

      infoOverlay.classList.remove('hidden');
      lightbox.classList.remove('hidden');
    }

    const commentsModal = document.getElementById('comments-modal');
    const closeComments = () => commentsModal.classList.add('hidden');

    document.getElementById('close-comments-icon')?.addEventListener('click', closeComments);
    commentsModal?.addEventListener('click', (e) => {
      if (e.target === commentsModal) closeComments();
    });

    window.openComments = async (postId) => {
      window.currentCommentPostId = postId;
      commentsModal.classList.remove('hidden');
      await renderComments(postId);
    }

    async function renderComments(postId) {
      const listEl = document.getElementById('comments-list');
      const { data: comments, error: commentsError } = await supabase.from('comments').select('*, profiles:user_id(full_name, avatar_url)').eq('post_id', postId).order('created_at', { ascending: true });

      const commentsHtml = await Promise.all((comments || []).map(async c => {
        let av = await getSignedUrl(c.profiles?.avatar_url);
        av = av || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
        return `<div class="comment-item" dir="auto">
                    <img src="${av}">
                    <div class="comment-text-box">
                        <strong>${escapeHtml(c.profiles?.full_name || 'User')}</strong>${escapeHtml(c.comment_text)}
                    </div>
                </div>`;
      }));

      listEl.innerHTML = commentsHtml.join('');
    }

    document.getElementById('send-comment-btn')?.addEventListener('click', async () => {
      const input = document.getElementById('comment-input');
      if (!input.value.trim()) return;
      await supabase.from('comments').insert([{ post_id: window.currentCommentPostId, user_id: currentUser.id, comment_text: input.value }]);
      input.value = '';
      renderComments(window.currentCommentPostId);
      loadPosts();
    });

    loadPosts();
  }

  if (isUploadPage) {
    window.DugitalLoader?.hide();
    const fileInput = document.getElementById('post-file');
    const previewContainer = document.getElementById('preview-container');
    const pubBtn = document.getElementById('publish-btn');
    window.selectedUploadType = 'image';

    const typeBtns = document.querySelectorAll('.upload-type-btn');
    typeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        typeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        window.selectedUploadType = btn.getAttribute('data-type');

        if (window.selectedUploadType === 'image') {
          fileInput.accept = 'image/*';
          fileInput.multiple = true;
        } else {
          fileInput.accept = 'video/*';
          fileInput.multiple = false;
        }
        fileInput.click();
      });
    });

    let selectedFiles = [];
    fileInput?.addEventListener('change', function (e) {
      selectedFiles = Array.from(e.target.files).slice(0, 20);
      if (selectedFiles.length > 0) {
        const file = selectedFiles[0];
        const url = URL.createObjectURL(file);

        if (file.type.startsWith('video/')) {
          previewContainer.innerHTML = `<video class="video-preview" src="${url}" muted autoplay loop></video>`;
        } else {
          previewContainer.innerHTML = `<img class="image-preview" src="${url}" alt="Preview">`;
          if (selectedFiles.length > 1) {
            previewContainer.innerHTML += `<div class="multiple-badge">+${selectedFiles.length - 1}</div>`;
          }
        }
        previewContainer.classList.remove('hidden');
      }
    });

    pubBtn?.addEventListener('click', async () => {
      const desc = document.getElementById('post-desc').value;
      const filesToUpload = selectedFiles.length > 0 ? selectedFiles : Array.from(fileInput.files || []).slice(0, 20);

      if (!desc && filesToUpload.length === 0) return alert('Write something or select a file.');

      pubBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...';
      pubBtn.disabled = true;
      window.DugitalLoader?.show('Publishing your story...');

      try {
        let mediaUrls = [];
        let mediaType = 'image';

        if (filesToUpload.length > 0) {
          for (let i = 0; i < filesToUpload.length; i++) {
            let file = filesToUpload[i];
            const fileExt = file.name.split('.').pop();
            const filePath = `${currentUser.id}/${Date.now()}_${i}.${fileExt}`;

            const { data, error: uploadError } = await supabase.storage.from('media').upload(filePath, file, {
              cacheControl: '3600',
              upsert: false
            });

            if (uploadError) throw uploadError;


            mediaUrls.push(filePath);
          }
          mediaType = filesToUpload[0].type.startsWith('video') ? (window.selectedUploadType === 'reel' ? 'reel' : 'video') : 'image';
        }

        const finalMediaUrl = mediaUrls.length > 0 ? mediaUrls.join(',') : null;

        const { error: postError } = await supabase.from('posts').insert([{ user_id: currentUser.id, description: desc, media_url: finalMediaUrl, media_type: mediaType }]);
        if (postError) throw postError;

        window.location.href = 'home.html';
      } catch (err) {
        pubBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
        pubBtn.disabled = false;
        window.DugitalLoader?.hide();
        alert('Error uploading: ' + err.message);
      }
    });
  }

  if (isProfilePage) {
    await profilePromise;
    if (currentProfile) {
      document.getElementById('profile-name-display').innerText = currentProfile.full_name || 'User';
      if (currentProfile.avatar_url) {

        document.getElementById('profile-img-preview').src = await getSignedUrl(currentProfile.avatar_url);
      }
    }

    const { data: myPosts } = await withTimeout(supabase.from('posts').select('id').eq('user_id', currentUser.id), 12000, 'Profile posts').catch(err => ({ data: null }));
    if (myPosts) document.getElementById('user-post-count').innerText = myPosts.length;
    window.DugitalLoader?.hide();

    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = 'index.html';
    });

    document.getElementById('profile-upload')?.addEventListener('change', async function (e) {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        const spinner = document.getElementById('upload-spinner');
        spinner.classList.remove('hidden');

        try {
          const filePath = `avatars/${currentUser.id}/${Date.now()}.${file.name.split('.').pop()}`;

          const { error: uploadError } = await supabase.storage.from('media').upload(filePath, file);
          if (uploadError) throw uploadError;


          await supabase.from('profiles').update({ avatar_url: filePath }).eq('id', currentUser.id);
          document.getElementById('profile-img-preview').src = await getSignedUrl(filePath);
        } catch (err) {
          alert('Error updating profile picture: ' + err.message);
        } finally {
          spinner.classList.add('hidden');
        }
      }
    });
  }
});
