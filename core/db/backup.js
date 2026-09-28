const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function getBackupDir() {
    return process.env.NHDL_BACKUP_DIR
        ? path.resolve(process.env.NHDL_BACKUP_DIR)
        : path.join(ROOT_DIR, 'data', 'backups');
}

function getDbModule() {
    return require('../db');
}

function ensureBackupDir() {
    const dir = getBackupDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getSafeFilename(filename) {
    if (!filename) throw new Error('Filename cannot be empty');
    const base = path.basename(filename);
    if (!base.endsWith('.json')) {
        throw new Error('Invalid backup file extension: must be .json');
    }
    return base;
}

async function createBackup(db = null, customName = null, keepOverride = null) {
    const dir = ensureBackupDir();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let filename = customName ? getSafeFilename(customName) : `nhdl-backup-${timestamp}.json`;
    let fullPath = path.join(dir, filename);
    if (!customName && fs.existsSync(fullPath)) {
        filename = `nhdl-backup-${timestamp}-${now.getMilliseconds()}.json`;
        fullPath = path.join(dir, filename);
    }

    const data = await getDbModule().exportData(db);
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(fullPath, jsonStr, 'utf8');

    const stats = fs.statSync(fullPath);

    let keep = keepOverride;
    if (keep === null || keep === undefined) {
        try {
            keep = await getDbModule().getSetting('backupKeep', 7, db);
        } catch {
            keep = 7;
        }
    }
    rotateBackups(Number(keep) || 7);

    return {
        filename,
        path: fullPath,
        size: stats.size,
        createdAt: now.toISOString()
    };
}

function listBackups() {
    const dir = ensureBackupDir();
    const files = fs.readdirSync(dir);
    const backups = [];

    for (const f of files) {
        if (!f.endsWith('.json') || !f.startsWith('nhdl-backup-')) continue;
        const p = path.join(dir, f);
        try {
            const stat = fs.statSync(p);
            backups.push({
                filename: f,
                size: stat.size,
                createdAt: stat.mtime.toISOString()
            });
        } catch (e) {}
    }

    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.filename.localeCompare(a.filename));
    return backups;
}

function rotateBackups(keep = 7) {
    try {
        const dir = ensureBackupDir();
        const maxKeep = (typeof keep === 'number' && keep > 0) ? keep : 7;
        const backups = listBackups();
        if (backups.length > maxKeep) {
            const toDelete = backups.slice(maxKeep);
            for (const b of toDelete) {
                try {
                    fs.unlinkSync(path.join(dir, b.filename));
                } catch (e) {}
            }
        }
    } catch (e) {}
}

async function restoreBackup(filename, mode = 'replace', db = null) {
    const dir = ensureBackupDir();
    const safeName = getSafeFilename(filename);
    const fullPath = path.join(dir, safeName);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Backup file not found: ${safeName}`);
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    const data = JSON.parse(raw);
    const result = await getDbModule().importData(data, { mode }, db);
    return {
        ...result,
        filename: safeName
    };
}

function deleteBackup(filename) {
    const dir = ensureBackupDir();
    const safeName = getSafeFilename(filename);
    const fullPath = path.join(dir, safeName);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Backup file not found: ${safeName}`);
    }
    fs.unlinkSync(fullPath);
    return { success: true, deleted: safeName };
}

let autoBackupTimer = null;
let lastAttemptTime = 0;

async function checkAndRunScheduledBackup(engine = null) {
    const db = getDbModule();
    try {
        const intervalHours = Number(await db.getSetting('backupIntervalHours', 24));
        if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
            return false; // 0 = disabled
        }

        const lastBackupAt = await db.getSetting('lastBackupAt', null);
        const now = Date.now();
        const intervalMs = intervalHours * 60 * 60 * 1000;

        const isDue = !lastBackupAt || (now - new Date(lastBackupAt).getTime() >= intervalMs);
        if (!isDue) return false;

        // If previous attempt failed, wait at least 10 minutes before retrying
        if (lastAttemptTime > 0 && (now - lastAttemptTime) < 10 * 60 * 1000) {
            return false;
        }

        lastAttemptTime = now;
        const keep = Number(await db.getSetting('backupKeep', 7)) || 7;
        const res = await createBackup(null, null, keep);
        await db.setSetting('lastBackupAt', new Date().toISOString());
        lastAttemptTime = 0;

        try {
            const { logActivity } = require('../logger');
            await logActivity(`Automated scheduled backup created: ${res.filename}`);
        } catch {}
        return res;
    } catch (err) {
        try {
            const { logActivity } = require('../logger');
            await logActivity(`Automated backup attempt failed (will retry in 10m): ${err.message}`, 'warn');
        } catch {}
        return false;
    }
}

function setupAutoBackup(engine, checkIntervalMs = 60 * 1000) {
    if (autoBackupTimer) clearInterval(autoBackupTimer);

    setTimeout(() => {
        checkAndRunScheduledBackup(engine).catch(() => {});
    }, 3000);

    autoBackupTimer = setInterval(() => {
        checkAndRunScheduledBackup(engine).catch(() => {});
    }, checkIntervalMs);
    if (autoBackupTimer.unref) autoBackupTimer.unref();
    return autoBackupTimer;
}

function stopAutoBackup() {
    if (autoBackupTimer) {
        clearInterval(autoBackupTimer);
        autoBackupTimer = null;
    }
}

module.exports = {
    get BACKUP_DIR() { return getBackupDir(); },
    getBackupDir,
    createBackup,
    listBackups,
    restoreBackup,
    deleteBackup,
    rotateBackups,
    checkAndRunScheduledBackup,
    setupAutoBackup,
    stopAutoBackup
};
