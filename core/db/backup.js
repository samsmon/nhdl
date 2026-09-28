const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const BACKUP_DIR = path.join(ROOT_DIR, 'data', 'backups');

function getDbModule() {
    return require('../db');
}

function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    return BACKUP_DIR;
}

function getSafeFilename(filename) {
    if (!filename) throw new Error('Filename cannot be empty');
    const base = path.basename(filename);
    if (!base.endsWith('.json')) {
        throw new Error('Invalid backup file extension: must be .json');
    }
    return base;
}

async function createBackup(db = null, customName = null) {
    const dir = ensureBackupDir();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = customName ? getSafeFilename(customName) : `nhdl-backup-${timestamp}.json`;
    const fullPath = path.join(dir, filename);

    const data = await getDbModule().exportData(db);
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(fullPath, jsonStr, 'utf8');

    const stats = fs.statSync(fullPath);

    // Rotate: keep latest 7 backups
    rotateBackups(7);

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

    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return backups;
}

function rotateBackups(keep = 7) {
    try {
        const backups = listBackups();
        if (backups.length > keep) {
            const toDelete = backups.slice(keep);
            for (const b of toDelete) {
                try {
                    fs.unlinkSync(path.join(BACKUP_DIR, b.filename));
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

function setupAutoBackup(engine, intervalMs = 24 * 60 * 60 * 1000) {
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    autoBackupTimer = setInterval(async () => {
        try {
            if (engine && !engine.isRunning && !engine.currentProgress) {
                const res = await createBackup();
                const { logActivity } = require('../logger');
                await logActivity(`Automated daily backup created: ${res.filename}`);
            }
        } catch (e) {}
    }, intervalMs);
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
    BACKUP_DIR,
    createBackup,
    listBackups,
    restoreBackup,
    deleteBackup,
    rotateBackups,
    setupAutoBackup,
    stopAutoBackup
};
