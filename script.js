const MEMORY_DB_NAME = 'love-journey-db';
const MEMORY_DB_VERSION = 1;
const MEMORY_STORE_NAME = 'memories';
const STORAGE_BUCKET_NAME = 'memories';
const MAX_IMAGE_FILE_SIZE = 1000000;
const MAX_TOTAL_IMAGE_SIZE = 4000000;

function isIndexedDBAvailable() {
    return typeof window !== 'undefined' && 'indexedDB' in window;
}

function createMemoryId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMemoryRecord(memory, fallbackIndex = 0) {
    return {
        ...memory,
        id: memory.id || createMemoryId(),
        title: memory.title || '',
        date: memory.date || '',
        location: memory.location || '',
        locationLat: memory.locationLat || '',
        locationLng: memory.locationLng || '',
        locationPlaceId: memory.locationPlaceId || '',
        text: memory.text || '',
        images: Array.isArray(memory.images) ? memory.images : []
    };
}

function readLegacyMemories() {
    try {
        return JSON.parse(localStorage.getItem('memories') || '[]');
    } catch (err) {
        return [];
    }
}

function writeLegacyMemories(memories) {
    try {
        localStorage.setItem('memories', JSON.stringify(memories));
        return true;
    } catch (err) {
        console.warn('Could not save to localStorage because the browser quota was exceeded or storage is unavailable.', err);
        return false;
    }
}

async function persistLocalMemories(memories) {
    const normalized = memories.map((memory, index) => normalizeMemoryRecord(memory, index));

    writeLegacyMemories(normalized);

    if (!isIndexedDBAvailable()) {
        return normalized;
    }

    try {
        const db = await openMemoryDB();
        const transaction = db.transaction(MEMORY_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(MEMORY_STORE_NAME);

        await new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error('Failed to clear memories.'));
        });

        for (const memory of normalized) {
            await new Promise((resolve, reject) => {
                const request = store.put(memory);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error || new Error('Failed to save memory.'));
            });
        }

        db.close();
        return normalized;
    } catch (err) {
        console.warn('IndexedDB persistence failed; keeping localStorage fallback.', err);
        return normalized;
    }
}

let supabaseClientInstance = null;

function getSupabaseClient() {
    if (!window.supabase || !window.SUPABASE_CONFIG) return null;
    const { url, anonKey } = window.SUPABASE_CONFIG || {};
    if (!url || !anonKey) return null;

    if (!supabaseClientInstance) {
        supabaseClientInstance = window.supabase.createClient(url, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }

    return supabaseClientInstance;
}

function openMemoryDB() {
    return new Promise((resolve, reject) => {
        if (!isIndexedDBAvailable()) {
            reject(new Error('IndexedDB is not supported in this browser.'));
            return;
        }

        const request = indexedDB.open(MEMORY_DB_NAME, MEMORY_DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(MEMORY_STORE_NAME)) {
                db.createObjectStore(MEMORY_STORE_NAME, { keyPath: 'id' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open memory database.'));
    });
}

async function getLocalMemories() {
    if (!isIndexedDBAvailable()) {
        return readLegacyMemories().map((memory, index) => normalizeMemoryRecord(memory, index));
    }

    try {
        const db = await openMemoryDB();
        const transaction = db.transaction(MEMORY_STORE_NAME, 'readonly');
        const store = transaction.objectStore(MEMORY_STORE_NAME);
        const result = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('Failed to read memories.'));
        });
        db.close();

        const normalized = result.map((memory, index) => normalizeMemoryRecord(memory, index));
        const legacy = readLegacyMemories().map((memory, index) => normalizeMemoryRecord(memory, index));

        if (!normalized.length && legacy.length) {
            await saveMemories(legacy);
            return legacy;
        }

        return normalized;
    } catch (err) {
        console.warn('IndexedDB unavailable or not ready, falling back to localStorage.', err);
        return readLegacyMemories().map((memory, index) => normalizeMemoryRecord(memory, index));
    }
}

async function getMemories() {
    const local = await getLocalMemories();
    const supabase = getSupabaseClient();

    if (!supabase) {
        return local;
    }

    try {
        const { data, error } = await supabase.from('memories').select('*').order('created_at', { ascending: false });
        if (error || !Array.isArray(data) || !data.length) {
            return local;
        }

        const remote = data.map((item) => normalizeMemoryRecord({
            id: item.id,
            title: item.title,
            date: item.date,
            location: item.location,
            locationLat: item.location_lat,
            locationLng: item.location_lng,
            locationPlaceId: item.location_place_id,
            text: item.text,
            images: Array.isArray(item.images) ? item.images : []
        }));

        const merged = [
            ...remote,
            ...local.filter((item) => !remote.some((candidate) => candidate.id === item.id))
        ];

        await persistLocalMemories(merged);
        return merged;
    } catch (err) {
        console.warn('Supabase read failed, falling back to local storage.', err);
        return local;
    }
}

async function saveMemories(memories) {
    const normalized = memories.map((memory, index) => normalizeMemoryRecord(memory, index));

    const supabase = getSupabaseClient();
    if (supabase) {
        try {
            const rows = [];
            const savedMemories = [];
            for (const memory of normalized) {
                const uploadedImages = [];
                for (const image of Array.isArray(memory.images) ? memory.images : []) {
                    const uploaded = await uploadImageToSupabaseStorage(image, memory.id);
                    uploadedImages.push({
                        name: uploaded.name || image.name || '',
                        data: uploaded.data || getImageSource(uploaded),
                        url: uploaded.url || getImageSource(uploaded)
                    });
                }

                rows.push({
                    id: memory.id,
                    title: memory.title,
                    date: memory.date,
                    location: memory.location,
                    location_lat: memory.locationLat,
                    location_lng: memory.locationLng,
                    location_place_id: memory.locationPlaceId,
                    text: memory.text,
                    images: uploadedImages
                });

                savedMemories.push({
                    ...memory,
                    images: uploadedImages
                });
            }

            const { error } = await supabase.from('memories').upsert(rows, { onConflict: 'id' });
            if (!error) {
                await persistLocalMemories(savedMemories);
                return savedMemories;
            }
            console.warn('Supabase write failed, continuing with local storage.', error);
        } catch (err) {
            console.warn('Supabase write failed, continuing with local storage.', err);
        }
    }

    if (!isIndexedDBAvailable()) {
        writeLegacyMemories(normalized);
        return normalized;
    }

    try {
        const db = await openMemoryDB();
        const transaction = db.transaction(MEMORY_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(MEMORY_STORE_NAME);
        await new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error('Failed to clear memories.'));
        });
        for (const memory of normalized) {
            await new Promise((resolve, reject) => {
                const request = store.put(memory);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error || new Error('Failed to save memory.'));
            });
        }
        db.close();
        await persistLocalMemories(normalized);
        return normalized;
    } catch (err) {
        console.warn('Falling back to localStorage because IndexedDB save failed.', err);
        await persistLocalMemories(normalized);
        return normalized;
    }
}

async function addMemory(memory) {
    const stored = await getMemories();
    const next = normalizeMemoryRecord({ ...memory, id: memory.id || createMemoryId() });
    const updated = [...stored, next];
    await saveMemories(updated);
    return next;
}

async function updateMemory(memoryId, memory) {
    const stored = await getMemories();
    const updated = stored.map((item) => item.id === memoryId ? normalizeMemoryRecord({ ...item, ...memory, id: memoryId }) : item);
    await saveMemories(updated);
    return updated.find((item) => item.id === memoryId) || null;
}

async function deleteMemory(memoryId) {
    const stored = await getMemories();
    const updated = stored.filter((item) => item.id !== memoryId);

    const supabase = getSupabaseClient();
    if (supabase) {
        try {
            await supabase.from('memories').delete().eq('id', memoryId);
        } catch (err) {
            console.warn('Could not delete the remote memory record; continuing with local update.', err);
        }
    }

    await saveMemories(updated);
    return updated;
}

// days thogeter 
function calculateDaysTogether() {
    const days = new Date(2025, 11, 24);
    //date today
    const today = new Date();
    //calculate days
    const dayDifference = Math.floor((today - days) / (1000 * 60 * 60 * 24));

    //insert into p
    const daysElement = document.getElementById('daysTogether');
    if (!daysElement) return;
    daysElement.textContent = `Dagen samen: ${dayDifference}`; 
}
// memmories made
async function calculateMemmories() {
    const stored = await getMemories();
    const el = document.getElementById('memoryMade');
    if (el) el.textContent = `Herinneringen gemaakt: ${stored.length}`;
}

function applyOrientationClass(el, width, height) {
    if (!el || !width || !height) return;
    el.classList.remove('portrait', 'landscape');
    el.classList.add(width >= height ? 'landscape' : 'portrait');
}

async function renderStoredMemories() {
    const list = document.getElementById('memmoriesList');
    if (!list) return;

    const stored = await getMemories();
    list.innerHTML = '';

    stored.forEach((memory, index) => {
        const card = document.createElement('div');
        card.className = 'Memmory';

        const content = document.createElement('div');
        content.className = 'memmory-content';

        const titleRow = document.createElement('div');
        titleRow.className = 'memmory-title-row';

        const title = document.createElement('h2');
        title.textContent = memory.title || 'Nieuwe herinnering';
        titleRow.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'memmory-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'edit-memory-btn';
        editBtn.textContent = '✎';
        editBtn.setAttribute('aria-label', 'Bewerk');
        const memoryId = memory.id || String(index);
        editBtn.addEventListener('click', () => {
            window.location.href = `Add-memmory.html?edit=${encodeURIComponent(memoryId)}`;
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'delete-memory-btn';
        deleteBtn.textContent = '🗑';
        deleteBtn.setAttribute('aria-label', 'Verwijder');
        deleteBtn.addEventListener('click', async () => {
            const ok = window.confirm('Weet je zeker dat je deze herinnering wilt verwijderen?');
            if (!ok) return;
            await deleteMemory(memoryId);
            await calculateMemmories();
            await renderStoredMemories();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        titleRow.appendChild(actions);

        content.appendChild(titleRow);

        if (memory.date) {
            const date = document.createElement('p');
            date.className = 'datum';
            date.textContent = formatDateEU(memory.date);
            content.appendChild(date);
        }

        if (memory.location) {
            const location = document.createElement('p');
            location.className = 'location';
            location.textContent = memory.location;
            content.appendChild(location);
        }

        if (memory.locationLat && memory.locationLng) {
            const map = document.createElement('div');
            map.className = 'memmory-map';
            map.dataset.lat = memory.locationLat;
            map.dataset.lng = memory.locationLng;
            map.dataset.title = memory.title || memory.location || 'Locatie';
            content.appendChild(map);
        }

        card.appendChild(content);

        const imageItems = (memory.images || []).map(normalizeImageData).filter(Boolean);
        if (imageItems.length) {
            const mediaWrap = document.createElement('div');
            mediaWrap.className = 'memmory-media';
            const slide = document.createElement('div');
            slide.className = 'Slide show';
            let slideIndex = 0;
            const setSlideOrientationFromItem = (item) => {
                if (!item) return;
                if (item.classList.contains('portrait')) {
                    slide.classList.remove('landscape');
                    slide.classList.add('portrait');
                } else if (item.classList.contains('landscape')) {
                    slide.classList.remove('portrait');
                    slide.classList.add('landscape');
                }
            };

            imageItems.forEach((img) => {
                const wrap = document.createElement('div');
                wrap.className = 'img slideshow slide-item';
                const imageSource = getImageSource(img);
                if (img && typeof imageSource === 'string' && imageSource.startsWith('data:video/')) {
                    const video = document.createElement('video');
                    video.src = imageSource;
                    video.controls = true;
                    video.preload = 'metadata';
                    video.loading = 'lazy';
                    video.addEventListener('loadedmetadata', () => {
                        applyOrientationClass(wrap, video.videoWidth, video.videoHeight);
                        if (wrap.classList.contains('active')) setSlideOrientationFromItem(wrap);
                    });
                    wrap.appendChild(video);
                } else if (img && typeof imageSource === 'string') {
                    const image = document.createElement('img');
                    image.src = imageSource;
                    image.alt = img.name || 'memory image';
                    image.loading = 'lazy';
                    image.decoding = 'async';
                    image.onload = () => {
                        applyOrientationClass(wrap, image.naturalWidth, image.naturalHeight);
                        if (wrap.classList.contains('active')) setSlideOrientationFromItem(wrap);
                    };
                    wrap.appendChild(image);
                }
                slide.appendChild(wrap);
            });

            const items = slide.querySelectorAll('.slide-item');
            const setActive = (index) => {
                items.forEach((item, i) => item.classList.toggle('active', i === index));
                setSlideOrientationFromItem(items[index]);
            };
            setActive(0);

            mediaWrap.appendChild(slide);

            if (items.length > 1) {
                const controls = document.createElement('div');
                controls.className = 'slide-controls';

                const prevBtn = document.createElement('button');
                prevBtn.type = 'button';
                prevBtn.className = 'slide-btn';
                prevBtn.textContent = '‹';

                const nextBtn = document.createElement('button');
                nextBtn.type = 'button';
                nextBtn.className = 'slide-btn';
                nextBtn.textContent = '›';

                const go = (dir) => {
                    slideIndex = (slideIndex + dir + items.length) % items.length;
                    setActive(slideIndex);
                };

                prevBtn.addEventListener('click', () => go(-1));
                nextBtn.addEventListener('click', () => go(1));

                controls.appendChild(prevBtn);
                controls.appendChild(nextBtn);
                mediaWrap.appendChild(controls);
            }

            card.appendChild(mediaWrap);
        }

        if (memory.text) {
            const text = document.createElement('p');
            text.className = 'textMemmory';
            text.textContent = memory.text;
            content.appendChild(text);
        }

        list.appendChild(card);
    });
    initMemoryMaps();
}

function parseDateToISO(value) {
    if (!value) return '';
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parts = trimmed.split(/[-/]/);
    if (parts.length !== 3) return '';
    const [d, m, y] = parts;
    if (!y || y.length !== 4) return '';
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
}

function getImageSource(item) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (typeof item.url === 'string' && item.url) return item.url;
    if (typeof item.data === 'string' && item.data) return item.data;
    return '';
}

function normalizeImageData(item) {
    if (!item) return null;
    const source = getImageSource(item);
    if (typeof item === 'string') return { name: '', data: item, url: item };
    if (typeof item === 'object') {
        return {
            name: item.name || '',
            data: item.data || source,
            url: item.url || source
        };
    }
    return null;
}

async function uploadImageToSupabaseStorage(image, memoryId) {
    const supabase = getSupabaseClient();
    if (!supabase) return normalizeImageData(image);

    const source = getImageSource(image);
    if (!source || !source.startsWith('data:')) return normalizeImageData(image);

    try {
        const response = await fetch(source);
        const blob = await response.blob();
        const safeName = String(image.name || 'memory-image')
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'memory-image';
        const path = `${memoryId || createMemoryId()}/${Date.now()}-${safeName}`;
        const file = new File([blob], safeName, { type: blob.type || 'application/octet-stream' });

        const { data, error } = await supabase.storage.from(STORAGE_BUCKET_NAME).upload(path, file, {
            cacheControl: '3600',
            upsert: false
        });

        if (error || !data) throw error || new Error('Failed to upload media to Supabase Storage.');

        const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET_NAME).getPublicUrl(data.path);
        return {
            name: safeName,
            data: publicUrlData.publicUrl,
            url: publicUrlData.publicUrl
        };
    } catch (err) {
        console.warn('Supabase Storage upload failed, keeping the inline image data.', err);
        return normalizeImageData(image);
    }
}

function renderMediaGallery(container, images) {
    if (!container) return;
    container.innerHTML = '';
    const normalized = (images || [])
        .map(normalizeImageData)
        .filter(Boolean);
    if (!normalized.length) return;

    const slide = document.createElement('div');
    slide.className = 'Slide show';
    let slideIndex = 0;

    const setSlideOrientationFromItem = (item) => {
        if (!item) return;
        if (item.classList.contains('portrait')) {
            slide.classList.remove('landscape');
            slide.classList.add('portrait');
        } else if (item.classList.contains('landscape')) {
            slide.classList.remove('portrait');
            slide.classList.add('landscape');
        }
    };

    normalized.forEach((img) => {
        const wrap = document.createElement('div');
        wrap.className = 'img slideshow slide-item';
        const imageSource = getImageSource(img);
        if (img && typeof imageSource === 'string' && imageSource.startsWith('data:video/')) {
            const video = document.createElement('video');
            video.src = imageSource;
            video.controls = true;
            video.preload = 'metadata';
            video.loading = 'lazy';
            video.addEventListener('loadedmetadata', () => {
                applyOrientationClass(wrap, video.videoWidth, video.videoHeight);
                if (wrap.classList.contains('active')) setSlideOrientationFromItem(wrap);
            });
            wrap.appendChild(video);
        } else if (img && typeof imageSource === 'string') {
            const image = document.createElement('img');
            image.src = imageSource;
            image.alt = img.name || 'memory image';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.onload = () => {
                applyOrientationClass(wrap, image.naturalWidth, image.naturalHeight);
                if (wrap.classList.contains('active')) setSlideOrientationFromItem(wrap);
            };
            wrap.appendChild(image);
        }
        slide.appendChild(wrap);
    });

    const items = slide.querySelectorAll('.slide-item');
    const setActive = (index) => {
        items.forEach((item, i) => item.classList.toggle('active', i === index));
        setSlideOrientationFromItem(items[index]);
    };
    setActive(0);

    container.appendChild(slide);

    if (items.length > 1) {
        const controls = document.createElement('div');
        controls.className = 'slide-controls';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'slide-btn';
        prevBtn.textContent = 'â€¹';

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'slide-btn';
        nextBtn.textContent = 'â€º';

        const go = (dir) => {
            slideIndex = (slideIndex + dir + items.length) % items.length;
            setActive(slideIndex);
        };

        prevBtn.addEventListener('click', () => go(-1));
        nextBtn.addEventListener('click', () => go(1));

        controls.appendChild(prevBtn);
        controls.appendChild(nextBtn);
        container.appendChild(controls);
    }
}

function formatDateEU(value) {
    if (!value) return '';
    // Expecting yyyy-mm-dd from the date input
    const parts = value.split('-');
    if (parts.length === 3) {
        const [y, m, d] = parts;
        if (y && m && d) return `${d}-${m}-${y}`;
    }
    return value;
}

function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsDataURL(file);
    });
}

function describeSaveError(err) {
    const details = [
        err && err.message,
        err && err.error_description,
        err && err.details,
        err && err.hint,
        typeof err === 'string' ? err : ''
    ].filter(Boolean).join(' ');

    const text = details || 'Onbekende fout.';

    if (/row-level security|permission|42501|401|403/i.test(text)) {
        return 'Opslaan is mislukt door een cloud-toegangsfout. Controleer je Supabase-RLS-instellingen of probeer opnieuw nadat de toegang is ingesteld.';
    }

    if (/too large|size|payload|limit/i.test(text)) {
        return 'Opslaan is mislukt omdat een bestand te groot is voor de cloud-opslag. Kies kleinere foto’s of video’s.';
    }

    return `Opslaan is mislukt: ${text}`;
}

function attachAddMemmoryHandler() {
    const form = document.getElementById('addMemmoryForm');
    if (!form) return;

    const params = new URLSearchParams(window.location.search);
    const editIdRaw = params.get('edit');
    const editId = editIdRaw !== null && editIdRaw !== '' ? String(editIdRaw) : null;
    const isEditMode = Boolean(editId);

    const formTitle = document.getElementById('memmoryFormTitle');
    const editNote = document.getElementById('memmoryEditNote');
    const submitBtn = document.getElementById('memmorySubmitBtn');
    const submitHint = document.getElementById('memmorySubmitHint');
    const clearEditMediaBtn = document.getElementById('clearEditMedia');

    const dateInput = document.getElementById('memmoryDate');
    const minDate = '2020-01-01';
    const todayStr = new Date().toISOString().slice(0, 10);
    if (dateInput) {
        dateInput.min = minDate;
        dateInput.max = todayStr;
    }

    const fileInput = document.getElementById('memmoryImages');
    const previewsContainer = document.getElementById('filePreviews');
    let selectedFiles = [];
    let currentImages = [];

    // Function to update previews
    function updatePreviews() {
        previewsContainer.innerHTML = '';
        let items = [];
        if (isEditMode) {
            const existing = currentImages.map((item) => ({
                source: 'existing',
                name: item.name || 'media',
                data: item.data || item.url || '',
                url: item.url || item.data || ''
            }));
            const pending = selectedFiles.map((item) => ({
                source: 'new',
                name: item.file.name,
                data: item.url,
                url: item.url
            }));
            items = existing.concat(pending);
        } else {
            items = selectedFiles.map((item) => ({
                source: 'new',
                name: item.file.name,
                data: item.url
            }));
        }

        items.forEach((item, index) => {
            const previewDiv = document.createElement('div');
            previewDiv.className = 'file-preview';
            const mediaWrap = document.createElement('div');
            mediaWrap.className = 'media';

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.type = 'button';
            deleteBtn.textContent = 'X';
            deleteBtn.onclick = () => {
                if (item.source === 'new') {
                    const newIndex = isEditMode ? index - currentImages.length : index;
                    const removed = selectedFiles.splice(newIndex, 1)[0];
                    if (removed && removed.url) URL.revokeObjectURL(removed.url);
                } else {
                    currentImages.splice(index, 1);
                }
                updatePreviews();
            };

            const previewSource = item.url || item.data || '';
            if (previewSource.startsWith('data:video/')) {
                const video = document.createElement('video');
                video.src = previewSource;
                video.controls = true;
                video.addEventListener('loadedmetadata', () => {
                    applyOrientationClass(mediaWrap, video.videoWidth, video.videoHeight);
                });
                mediaWrap.appendChild(video);
            } else if (previewSource) {
                const img = document.createElement('img');
                img.src = previewSource;
                img.alt = item.name || 'memory image';
                img.onload = () => applyOrientationClass(mediaWrap, img.naturalWidth, img.naturalHeight);
                mediaWrap.appendChild(img);
            }

            const fileName = document.createElement('p');
            fileName.textContent = item.name || 'media';
            previewDiv.appendChild(mediaWrap);
            previewDiv.appendChild(fileName);
            previewDiv.appendChild(deleteBtn);
            previewsContainer.appendChild(previewDiv);
        });
    }

    // Handle file selection
    fileInput.addEventListener('change', (e) => {
        const newFiles = Array.from(e.target.files);
        const mapped = newFiles.map((file) => ({
            file,
            url: URL.createObjectURL(file)
        }));

        selectedFiles = selectedFiles.concat(mapped);

        updatePreviews();
        // Allow re-selecting the same file again if needed
        fileInput.value = '';
    });

    if (isEditMode) {
        getMemories().then((stored) => {
            const memory = stored.find((item) => String(item.id) === String(editId));
            if (!memory) return;
            const titleInput = document.getElementById('memmoryTitle');
            const locationInput = document.getElementById('memmoryLocation');
            const textInput = document.getElementById('memmoryText');
            const latInput = document.getElementById('memmoryLat');
            const lngInput = document.getElementById('memmoryLng');
            const placeIdInput = document.getElementById('memmoryPlaceId');
            if (titleInput) titleInput.value = memory.title || '';
            if (dateInput) dateInput.value = memory.date || '';
            if (locationInput) locationInput.value = memory.location || '';
            if (textInput) textInput.value = memory.text || '';
            if (latInput) latInput.value = memory.locationLat || '';
            if (lngInput) lngInput.value = memory.locationLng || '';
            if (placeIdInput) placeIdInput.value = memory.locationPlaceId || '';

            currentImages = (memory.images || []).map(normalizeImageData).filter(Boolean);
            updatePreviews();

            if (formTitle) formTitle.textContent = 'Bewerk herinnering';
            if (submitBtn) submitBtn.value = 'Update';
            if (submitHint) submitHint.textContent = 'Klik op Update om terug te keren naar de hoofdpagina.';
            if (editNote) editNote.classList.remove('is-hidden');
            if (clearEditMediaBtn) clearEditMediaBtn.classList.remove('is-hidden');
        });
    }

    if (clearEditMediaBtn) {
        clearEditMediaBtn.addEventListener('click', () => {
            selectedFiles.forEach((item) => item && item.url && URL.revokeObjectURL(item.url));
            selectedFiles = [];
            currentImages = [];
            updatePreviews();
        });
    }

    const saveStatus = document.getElementById('saveStatus');

    function updateSaveStatus(message, tone = '') {
        if (!saveStatus) return;
        saveStatus.textContent = message;
        saveStatus.className = `save-status ${tone}`.trim();
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        updateSaveStatus('Bezig met opslaan…', 'is-saving');
        const fd = new FormData(form);
        const dateStr = fd.get('date');
        if (dateInput) dateInput.setCustomValidity('');
        if (dateStr) {
            if (dateStr < minDate) {
                if (dateInput) {
                    dateInput.setCustomValidity('Datum mag niet voor 2020 zijn.');
                    dateInput.reportValidity();
                }
                return;
            }
            if (dateStr > todayStr) {
                if (dateInput) {
                    dateInput.setCustomValidity('Datum mag niet in de toekomst liggen.');
                    dateInput.reportValidity();
                }
                return;
            }
        }

        const memory = {
            title: fd.get('title') || '',
            date: fd.get('date') || '',
            location: fd.get('memmoryLocation') || '',
            locationLat: fd.get('memmoryLat') || '',
            locationLng: fd.get('memmoryLng') || '',
            locationPlaceId: fd.get('memmoryPlaceId') || '',
            text: fd.get('text') || '',
            images: []
        };

        if (isEditMode) {
            memory.images = currentImages.slice();
        }
        // Use selectedFiles instead of fd.getAll('images')
        for (const item of selectedFiles) {
            const f = item && item.file;
            if (f && f.size) {
                try {
                    const data = await fileToDataURL(f);
                    memory.images.push({ name: f.name, data });
                } catch (err) {
                    console.warn('Kon bestand niet lezen', f.name);
                }
            }
        }

        try {
            if (isEditMode && editId) {
                await updateMemory(editId, memory);
            } else {
                await addMemory(memory);
            }
        } catch (err) {
            console.error('Opslaan in de database mislukt', err);
            const message = describeSaveError(err);
            updateSaveStatus(message, 'is-error');
            alert(message);
            return;
        }

        updateSaveStatus('Herinnering opgeslagen!', 'is-saved');
        const stored = await getMemories();
        const el = document.getElementById('memoryMade');
        if (el) el.textContent = `Herinneringen gemaakt: ${stored.length}`;

        // Clean up object URLs
        selectedFiles.forEach((item) => {
            if (item && item.url) URL.revokeObjectURL(item.url);
        });
        selectedFiles = [];

        setTimeout(() => { window.location.href = 'Love website.html'; }, 250);
    });
}


let openStoredMemoryEditor = () => {};

//function calculateKisses
function calculateKisses() {
    // Get stored kisses or start with initial value
    let kisses = parseInt(localStorage.getItem('kisses')) || 9999;
    const lastKissDate = localStorage.getItem('lastKissDate');
    const today = new Date().toDateString();
    
    // Check if it's a new day
    if (lastKissDate !== today) {
        kisses += 100; // Add 100 kisses for the new day
        localStorage.setItem('kisses', kisses);
        localStorage.setItem('lastKissDate', today);
    }
    
    // Display the kisses
    const kissesElement = document.getElementById('kisses');
    if (!kissesElement) return;
    kissesElement.textContent = `Kusjes: ${kisses}`;
}

// submit form



document.addEventListener('DOMContentLoaded', async () => {
    calculateDaysTogether();
    calculateKisses();
    await calculateMemmories();
    await renderStoredMemories();
    attachAddMemmoryHandler();
    initAddMemoryMap();

    // If there's an element with id 'openAddMemmory', keep behaviour safe (anchor already navigates)
    const openBtn = document.getElementById('openAddMemmory');
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            window.location.href = 'Add-memmory.html';
        });
    }

});

function initAddMemoryMap() {
    const mapEl = document.getElementById('mapPicker');
    const input = document.getElementById('memmoryLocation');
    if (!mapEl || !input || !window.L) return;

    const latEl = document.getElementById('memmoryLat');
    const lngEl = document.getElementById('memmoryLng');
    const placeIdEl = document.getElementById('memmoryPlaceId');
    const searchBtn = document.getElementById('locationSearchBtn');

    const fallbackCenter = [52.3676, 4.9041];
    const map = L.map(mapEl).setView(fallbackCenter, 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const marker = L.marker(fallbackCenter, { draggable: true }).addTo(map);

    const setLatLng = (lat, lng, label) => {
        marker.setLatLng([lat, lng]);
        if (latEl) latEl.value = String(lat);
        if (lngEl) lngEl.value = String(lng);
        if (placeIdEl) placeIdEl.value = '';
        if (label) input.value = label;
    };

    marker.on('dragend', () => {
        const pos = marker.getLatLng();
        setLatLng(pos.lat, pos.lng);
    });

    map.on('click', (e) => {
        setLatLng(e.latlng.lat, e.latlng.lng);
    });

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            const center = [pos.coords.latitude, pos.coords.longitude];
            map.setView(center, 13);
            marker.setLatLng(center);
            setLatLng(center[0], center[1]);
        });
    }

    if (searchBtn) {
        searchBtn.addEventListener('click', async () => {
            const q = input.value.trim();
            if (!q) return;
            try {
                const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) return;
                const data = await res.json();
                if (!data || !data.length) return;
                const item = data[0];
                const lat = parseFloat(item.lat);
                const lng = parseFloat(item.lon);
                if (Number.isNaN(lat) || Number.isNaN(lng)) return;
                map.setView([lat, lng], 14);
                setLatLng(lat, lng, item.display_name);
            } catch (err) {
                console.warn('Locatie zoeken mislukt');
            }
        });
    }
}

function initMemoryMaps() {
    if (!window.L) return;
    const maps = document.querySelectorAll('.memmory-map');
    maps.forEach((el) => {
        if (el.dataset.initialized === 'true') return;
        const lat = parseFloat(el.dataset.lat || '');
        const lng = parseFloat(el.dataset.lng || '');
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;

        const map = L.map(el, { zoomControl: false, attributionControl: false }).setView([lat, lng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        L.marker([lat, lng]).addTo(map);
        el.dataset.initialized = 'true';
    });
}
