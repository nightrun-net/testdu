import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const supabaseUrl = 'https://vycidctybcihudvuydwj.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ5Y2lkY3R5YmNpaHVkdnV5ZHdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0NDE5MjMsImV4cCI6MjEwNjAxNzkyM30.WtaUyVNEBdSmodPCNFGM9X_ArW07QcemmyQIGQeLmyg';
const supabase = createClient(supabaseUrl, supabaseKey);

let currentUser = null;
let currentProfile = null;
window.currentCommentPostId = null;
let currentDeletePostId = null; 
window.currentLoadedPosts = []; 

const escapeHtml = (t) => {
    if(!t) return '';
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
};

 
async function getSignedUrl(url) {
    if (!url) return null;
    let path = url;
    const marker = '/object/public/media/';
    if (url.includes(marker)) path = url.split(marker)[1];
    if (path.startsWith('http')) return url;

    const { data, error } = await supabase.storage.from('media').createSignedUrl(path, 60 * 60 * 24);
    return data?.signedUrl || url;
}

document.addEventListener('DOMContentLoaded', async () => {
    
    const currentPageStr = window.location.pathname.split('/').pop().toLowerCase();
    const isIndexPage = currentPageStr === '' || currentPageStr.includes('index');
    const isHomePage = currentPageStr.includes('home');
    const isLikedPage = currentPageStr.includes('liked');
    const isUploadPage = currentPageStr.includes('upload');
    const isProfilePage = currentPageStr.includes('profile');

    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session && !isIndexPage) {
        window.location.href = 'index.html'; return;
    }
    if (session && isIndexPage) {
        window.location.href = 'home.html'; return;
    }

    if (session) {
        currentUser = session.user;
        const { data } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
        currentProfile = data;
    }

    let lastScroll = 0;
    window.addEventListener('scroll', () => {
        const header = document.getElementById('main-header');
        if(!header) return;
        const currentScroll = window.pageYOffset;
        if (currentScroll > lastScroll && currentScroll > 50) {
            header.classList.add('header-hidden');
        } else {
            header.classList.remove('header-hidden');
        }
        lastScroll = currentScroll;
    });

    if (isIndexPage) {
        const emailInput = document.getElementById('email');
        const passInput = document.getElementById('password');
        const loginBtn = document.getElementById('login-btn');

        emailInput?.addEventListener('keypress', (e) => {
            if(e.key === 'Enter') passInput.focus();
        });
        passInput?.addEventListener('keypress', (e) => {
            if(e.key === 'Enter') loginBtn.click();
        });

        loginBtn?.addEventListener('click', async () => {
            const { error } = await supabase.auth.signInWithPassword({ email: emailInput.value, password: passInput.value });
            if (error) document.getElementById('auth-error').innerText = "Invalid credentials!";
            else window.location.href = 'home.html';
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
            if(counterEl) counterEl.innerText = `${currentIndex}/${total}`;
        };

        async function loadPosts() {
            let myLikedIds = [];
            if (currentUser) {
                const { data: likesData } = await supabase
                    .from('likes')
                    .select('post_id')
                    .eq('user_id', currentUser.id);
                if (likesData) {
                    myLikedIds = likesData.map(l => String(l.post_id));
                }
            }

            const { data: posts } = await supabase
                .from('posts')
                .select(`*, profiles:user_id(full_name, avatar_url), likes(user_id), comments(id)`)
                .order('created_at', { ascending: false });

            if (posts) {
                window.currentLoadedPosts = posts; 
                postsFeed.innerHTML = '';
                
                if (isLikedPage && myLikedIds.length === 0) {
                    postsFeed.innerHTML = '<p style="text-align:center; margin-top: 50px; color: #888; font-family: Poppins;">چو پۆست نەهاتینە لایك كرن...</p>';
                    return;
                }

                for (const post of posts) {
                    const safeLikes = Array.isArray(post.likes) ? post.likes : [];
                    const safeComments = Array.isArray(post.comments) ? post.comments : [];
                    
                    const isLiked = myLikedIds.includes(String(post.id));
                    
                    if (isLikedPage && !isLiked) continue;

                    const postDate = new Date(post.created_at);
                    const day = postDate.getDate();
                    const month = postDate.getMonth() + 1;
                    const year = postDate.getFullYear();
                    const time = postDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    const formattedDate = `${day}/${month}/${year} ${time}`;
                    
                    let mediaHTML = '';
                    if (post.media_url) {
                        const rawUrls = post.media_url.split(','); 
                        const urls = [];
                        for (let u of rawUrls) {
                            urls.push(await getSignedUrl(u));
                        }
                        
                        if (post.media_type === 'image' && urls.length > 1) {
                            let gridImages = '';
                            let maxDisplay = 4;
                            if (urls.length === 2) maxDisplay = 2;
                            else if (urls.length === 3) maxDisplay = 3;
                            else if (urls.length === 4 || urls.length === 5) maxDisplay = 4;
                            else if (urls.length >= 6) maxDisplay = 6;
                            
                            const displayUrls = urls.slice(0, maxDisplay); 
                            
                            displayUrls.forEach((url, index) => {
                                if (index === (maxDisplay - 1) && urls.length > maxDisplay) {
                                    const extraCount = urls.length - maxDisplay;
                                    gridImages += `<div class="grid-img-wrapper" onclick="window.openZoom('${post.id}')"><img class="grid-img" src="${url}"><div class="grid-overlay">+${extraCount}</div></div>`;
                                } else {
                                    gridImages += `<div class="grid-img-wrapper" onclick="window.openZoom('${post.id}')"><img class="grid-img" src="${url}"></div>`;
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
                                mediaHTML = `<img src="${url}" alt="Post" onclick="window.openZoom('${post.id}')" style="width: 100%; max-height: 600px; object-fit: cover; cursor: pointer;">`;
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
                    if(shortDesc.length > 200) {
                        let truncated = shortDesc.substring(0, 200) + '...';
                        descHTML = `<span class="desc-text" data-full="${escapeHtml(shortDesc)}" data-short="${escapeHtml(truncated)}">${escapeHtml(truncated)}</span><button class="read-more-btn" onclick="window.toggleInlineDesc(this, event)">more</button>`;
                    } else if(shortDesc.length > 0) {
                        descHTML = `<span class="desc-text">${escapeHtml(shortDesc)}</span>`;
                    }

                    const postHTML = `
                        <div class="post-card" id="post-${post.id}">
                            <div class="post-header">
                                <img src="${avatar}" class="user-icon">
                                <h4>${name} <span>${formattedDate}</span></h4>
                                ${isMyPost ? `<button class="post-options-btn" onclick="window.confirmDelete('${post.id}')"><i class="fa-solid fa-ellipsis"></i></button>` : ''}
                            </div>
                            
                            <div class="post-media">${mediaHTML}</div>
                            
                            <div class="post-actions-bar">
                                <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="window.toggleLike('${post.id}', this)">
                                    <i class="${isLiked ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                                </button>
                                <button class="comment-btn" onclick="window.openComments('${post.id}')">
                                    <i class="fa-regular fa-comment"></i>
                                </button>
                            </div>
                            
                            <div class="post-likes-count">${safeLikes.length} Likes &bull; ${commentsCount} Comments</div>
                            
                            ${post.description ? `
                                <div class="post-desc-container">
                                    <strong class="post-author">${name}</strong>
                                    <div class="post-desc-content" dir="auto">${descHTML}</div>
                                </div>
                            ` : ''}
                        </div>
                    `;
                    postsFeed.insertAdjacentHTML('beforeend', postHTML);
                }

                if (postsFeed.innerHTML === '') {
                    postsFeed.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: #888;">چو پۆست نەهاتینە دیتن...</div>';
                }
            }
        }
        
        window.toggleInlineDesc = (btn, event) => {
            if(event) event.stopPropagation();
            const textSpan = btn.previousElementSibling;
            if (btn.innerText === 'less') {
                textSpan.innerHTML = textSpan.getAttribute('data-short');
                btn.innerText = 'more';
            } else {
                textSpan.innerHTML = textSpan.getAttribute('data-full');
                btn.innerText = 'less';
            }
        };

        window.toggleLike = async (postId, btnElement) => {
            const currentlyLiked = btnElement.classList.contains('liked');
            const card = btnElement.closest('.post-card');
            const likesCountEl = card.querySelector('.post-likes-count');
            
            let currentText = likesCountEl.innerText || "";
            let likesPart = currentText.split('•')[0] || "0 Likes";
            let commentsPart = currentText.split('•')[1] || "0 Comments";
            let likesNum = parseInt(likesPart.replace(/[^0-9]/g, '')) || 0;

            if (currentlyLiked) {
                btnElement.classList.remove('liked');
                btnElement.innerHTML = '<i class="fa-regular fa-heart"></i>';
                
                likesNum = Math.max(0, likesNum - 1);
                likesCountEl.innerHTML = `${likesNum} Likes &bull; ${commentsPart.trim()}`;
                
                await supabase.from('likes').delete().match({ post_id: postId, user_id: currentUser.id });
                if(isLikedPage) {
                    document.getElementById(`post-${postId}`)?.remove();
                }
            } else {
                btnElement.classList.add('liked');
                btnElement.innerHTML = '<i class="fa-solid fa-heart"></i>';
                
                likesNum += 1;
                likesCountEl.innerHTML = `${likesNum} Likes &bull; ${commentsPart.trim()}`;
                
                await supabase.from('likes').insert([{ post_id: postId, user_id: currentUser.id }]);
            }
        }

        const deleteModal = document.getElementById('delete-modal');
        window.confirmDelete = (postId) => {
            currentDeletePostId = postId;
            deleteModal.classList.remove('hidden');
        }
        document.getElementById('cancel-delete-btn')?.addEventListener('click', () => deleteModal.classList.add('hidden'));
        document.getElementById('confirm-delete-btn')?.addEventListener('click', async () => {
            if(currentDeletePostId) {
                await supabase.from('posts').delete().eq('id', currentDeletePostId);
                deleteModal.classList.add('hidden');
                document.getElementById(`post-${currentDeletePostId}`)?.remove();
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
            lightboxContainer.innerHTML = ''; 
            sliderCounterTop.classList.add('hidden');
            closeLightboxBtn.style.zIndex = '20010';
        });
        
        window.openZoom = async (postId) => {
            const post = window.currentLoadedPosts.find(p => p.id === postId);
            if(!post) return; 

            let av = await getSignedUrl(post.profiles?.avatar_url);
            av = av || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
            const name = post.profiles?.full_name || 'User';
            
            if (post.media_type === 'image') {
                const rawUrls = post.media_url.split(','); 
                const urls = [];
                for (let u of rawUrls) {
                    urls.push(await getSignedUrl(u));
                }
                
                if (urls.length > 1) {
                    sliderCounterTop.innerText = `1/${urls.length}`;
                    sliderCounterTop.classList.remove('hidden');
                    closeLightboxBtn.style.zIndex = '20030';
                    
                    let slides = urls.map(url => `<img class="slider-img" src="${url}">`).join('');
                    lightboxContainer.innerHTML = `
                        <div class="media-slider-container">
                            <div class="media-slider" onscroll="window.updateSliderCounter(this, '${post.id}', ${urls.length})">
                                ${slides}
                            </div>
                        </div>
                    `;
                } else {
                    lightboxContainer.innerHTML = `<img src="${urls[0]}" style="width: 100%; max-height: 85vh; object-fit: contain;">`;
                }
            } else {
                const vidClass = post.media_type === 'reel' ? 'zoom-reel-video' : 'zoom-normal-video';
                const signedVidUrl = await getSignedUrl(post.media_url);
                lightboxContainer.innerHTML = `<video id="zoom-video" class="${vidClass}" src="${signedVidUrl}" autoplay loop playsinline></video>`;
                
                setTimeout(() => {
                    const vid = document.getElementById('zoom-video');
                    if(vid) {
                        vid.onclick = () => {
                            if(vid.paused) vid.play();
                            else vid.pause();
                        };
                    }
                }, 100);
            }

            let shortDescZoom = (post.description || '').trim();
            let zoomDescHTML = '';
            if(shortDescZoom.length > 200) {
                let truncatedZ = shortDescZoom.substring(0, 200) + '...';
                zoomDescHTML = `<span class="desc-text" data-full="${escapeHtml(shortDescZoom)}" data-short="${escapeHtml(truncatedZ)}">${escapeHtml(truncatedZ)}</span><button class="read-more-btn" onclick="window.toggleInlineDesc(this, event)">more</button>`;
            } else if(shortDescZoom.length > 0) {
                zoomDescHTML = `<span class="desc-text">${escapeHtml(shortDescZoom)}</span>`;
            }

            infoOverlay.innerHTML = `
                <div class="lightbox-user"><img src="${av}"><strong>${name}</strong></div>
                ${zoomDescHTML ? `<div class="lightbox-desc" dir="auto">${zoomDescHTML}</div>` : ''}
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
            const { data: comments } = await supabase.from('comments').select('*, profiles:user_id(full_name, avatar_url)').eq('post_id', postId).order('created_at', { ascending: true });
            
            const commentsHtml = await Promise.all(comments.map(async c => {
                let av = await getSignedUrl(c.profiles?.avatar_url);
                av = av || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
                return `<div class="comment-item" dir="auto">
                    <img src="${av}">
                    <div class="comment-text-box">
                        <strong>${c.profiles?.full_name || 'User'}</strong>${c.comment_text}
                    </div>
                </div>`;
            }));
            
            listEl.innerHTML = commentsHtml.join('');
        }

        document.getElementById('send-comment-btn')?.addEventListener('click', async () => {
            const input = document.getElementById('comment-input');
            if(!input.value.trim()) return;
            await supabase.from('comments').insert([{ post_id: window.currentCommentPostId, user_id: currentUser.id, comment_text: input.value }]);
            input.value = '';
            renderComments(window.currentCommentPostId);
            loadPosts(); 
        });
        
        loadPosts();
    }

    if (isUploadPage) {
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
                
                if(window.selectedUploadType === 'image') {
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
        fileInput?.addEventListener('change', function(e) {
            selectedFiles = Array.from(e.target.files).slice(0, 20); 
            if(selectedFiles.length > 0) {
                const file = selectedFiles[0];
                const url = URL.createObjectURL(file);
                
                if(file.type.startsWith('video/')) {
                    previewContainer.innerHTML = `<video class="video-preview" src="${url}" muted autoplay loop></video>`;
                } else {
                    previewContainer.innerHTML = `<img class="image-preview" src="${url}" alt="Preview">`;
                    if(selectedFiles.length > 1) {
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

            pubBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            pubBtn.disabled = true;
            
            try {
                let mediaUrls = [];
                let mediaType = 'image';
                
                if (filesToUpload.length > 0) {
                    for(let i = 0; i < filesToUpload.length; i++) {
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
            } catch(err) {
                pubBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
                pubBtn.disabled = false;
                alert('Error uploading: ' + err.message);
            }
        });
    }

    if (isProfilePage) {
        if (currentProfile) {
            document.getElementById('profile-name-display').innerText = currentProfile.full_name || 'User';
            if(currentProfile.avatar_url) {
               
                document.getElementById('profile-img-preview').src = await getSignedUrl(currentProfile.avatar_url);
            }
        }

        const { data: myPosts } = await supabase.from('posts').select('id').eq('user_id', currentUser.id);
        if (myPosts) document.getElementById('user-post-count').innerText = myPosts.length;

        document.getElementById('logout-btn')?.addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.href = 'index.html';
        });

        document.getElementById('profile-upload')?.addEventListener('change', async function(e) {
            if(e.target.files && e.target.files[0]) {
                const file = e.target.files[0];
                const spinner = document.getElementById('upload-spinner');
                spinner.classList.remove('hidden'); 
                
                try {
                    const filePath = `avatars/${currentUser.id}/${Date.now()}.${file.name.split('.').pop()}`;
                    
                    const { error: uploadError } = await supabase.storage.from('media').upload(filePath, file);
                    if (uploadError) throw uploadError;
                    
                    
                    await supabase.from('profiles').update({ avatar_url: filePath }).eq('id', currentUser.id);
                    document.getElementById('profile-img-preview').src = await getSignedUrl(filePath);
                } catch(err) {
                    alert('Error updating profile picture: ' + err.message);
                } finally {
                    spinner.classList.add('hidden');
                }
            }
        });
    }
});
