function normalizeGalleryId(galleryId) {
    const num = typeof galleryId === 'number' ? galleryId : parseInt(String(galleryId).trim(), 10);
    if (!Number.isFinite(num) || num <= 0) {
        throw new Error(`Invalid gallery_id: ${galleryId}`);
    }
    return num;
}

function formatQueueRow(r) {
    if (!r) return null;
    const displayStatus = r.error ? `${r.status} - ${r.error}` : r.status;
    const displayUrl = r.title ? `${r.url} | ${r.title}` : r.url;
    return {
        id: r.id,
        galleryId: r.gallery_id,
        status: displayStatus,
        rawStatus: r.status,
        url: displayUrl,
        title: r.title,
        batch: r.batch || 1,
        priority: r.priority || 0,
        pagesDone: r.pages_done || 0,
        pagesTotal: r.pages_total || 0,
        error: r.error || null,
        retries: r.retries || 0,
        format: r.format || null,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
    };
}

function maskDatabaseUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.password) {
            parsed.password = '***';
        }
        return parsed.toString();
    } catch {
        return url.replace(/:([^:@/]+)@/, ':***@');
    }
}

module.exports = {
    normalizeGalleryId,
    formatQueueRow,
    maskDatabaseUrl
};
