const dbLocal = require('../db/database');
const { db, connectFirebase } = require('../config/firebaseConfig');
const { ref, get, update, child } = require("firebase/database");
const crypto = require('crypto');

// Bandera para evitar conflictos de concurrencia
let isSyncing = false;

// 1. MOTOR DE ARRANQUE
const startSyncEngine = () => {
    console.log("🔄 Motor de sincronización iniciado. (Intervalo: 60s)");
    
    // Ejecutar inmediatamente al arrancar para traer datos
    runBidirectionalSync();

    // Programar ciclo infinito
    setInterval(() => {
        runBidirectionalSync();
    }, 60 * 1000);
};

// 2. MARCAR CAMBIOS LOCALES
const touchLocalChange = async () => {
    const now = new Date().toISOString();
    return new Promise((resolve) => {
        dbLocal.run(
            `INSERT INTO app_meta (key, value) VALUES ('local_last_change_at', ?) 
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [now],
            (err) => {
                if(err) console.error("Error timestamp local:", err);
                resolve();
            }
        );
    });
};

// 3. LÓGICA PRINCIPAL DE SINCRONIZACIÓN
const runBidirectionalSync = async () => {
    if (isSyncing) return;
    isSyncing = true;
    
    try {
        await connectFirebase();

        // Obtener "foto" actual de ambos lados
        const localData = await getAllLocalData();
        const dbRef = ref(db);
        const snapshot = await get(child(dbRef, "/"));
        const remoteData = snapshot.exists() ? snapshot.val() : {};

        // -----------------------------------------------------------------------
        // 🛡️ SALVAGUARDA DE SEGURIDAD (CRÍTICA)
        // Evita que un PC nuevo borre los datos de Firebase
        // -----------------------------------------------------------------------
        const localHasProjects = localData.proyectos && Object.keys(localData.proyectos).length > 0;
        const remoteHasProjects = remoteData.proyectos && Object.keys(remoteData.proyectos).length > 0;

        // CASO 1: Soy un PC nuevo (vacío) y en la nube hay datos -> ¡DESCARGAR SIEMPRE!
        if (!localHasProjects && remoteHasProjects) {
            console.warn("🛡️ DETECTADO: Base local vacía vs Nube con datos. FORZANDO DESCARGA DE SEGURIDAD.");
            await upsertRemoteIntoLocal(remoteData);
            // Igualamos la fecha para que quede sincronizado
            await touchLocalChange(); 
            console.log("✅ Recuperación de datos completada exitosamente.");
            isSyncing = false;
            return; // ¡IMPORTANTE! Salir aquí para no ejecutar nada más.
        }
        // -----------------------------------------------------------------------

        // Comparación de Fechas (Solo si pasamos la salvaguarda)
        const localTime = new Date(localData.meta.local_last_change_at || 0).getTime();
        const remoteTime = new Date(remoteData.meta?.last_change_at || 0).getTime();

        // Margen de 2 segundos para evitar bucles tontos
        const diff = Math.abs(localTime - remoteTime);
        if (diff < 2000) {
            isSyncing = false;
            return;
        }

        if (localTime > remoteTime) {
            // CASO 2: Subida legítima (Cargué un Excel o edité algo)
            console.log(`📤 Subiendo cambios locales... (L: ${localTime} > R: ${remoteTime})`);
            
            const payload = {
                "meta": { "last_change_at": new Date().toISOString() },
                "municipios": arrayToObject(localData.municipios),
                "instituciones": arrayToObject(localData.instituciones),
                "sedes": arrayToObject(localData.sedes),
                "indicadores": arrayToObject(localData.indicadores),
                "proyectos": arrayToObject(localData.proyectos),
                "actividades": arrayToObject(localData.actividades),
                "seguimientos": arrayToObject(localData.seguimientos)
            };

            await update(ref(db), payload);
            console.log("✅ Datos subidos a Firebase.");

        } else if (remoteTime > localTime) {
            // CASO 3: Alguien más actualizó la nube -> Descargar
            console.log(`📥 Descargando nuevos datos... (R: ${remoteTime} > L: ${localTime})`);
            await upsertRemoteIntoLocal(remoteData);
            await touchLocalChange();
            console.log("✅ Datos locales actualizados.");
        }

    } catch (error) {
        console.error("❌ Error Sync:", error.message);
    } finally {
        isSyncing = false;
    }
};

// --- FUNCIONES AUXILIARES ---

function arrayToObject(arr) {
    if (!arr) return {};
    const obj = {};
    arr.forEach(item => {
        const key = item.sync_uid || `id_${item.id}`;
        const cleanItem = {};
        Object.keys(item).forEach(k => {
            if (item[k] !== null && item[k] !== undefined) cleanItem[k] = item[k];
        });
        obj[key] = cleanItem;
    });
    return obj;
}

async function getAllLocalData() {
    const getTable = (table) => new Promise((resolve) => {
        dbLocal.all(`SELECT * FROM ${table}`, (err, rows) => resolve(err ? [] : rows));
    });
    const getMeta = () => new Promise((resolve) => {
        dbLocal.get(`SELECT value FROM app_meta WHERE key='local_last_change_at'`, (err, row) => resolve(row ? row.value : null));
    });

    return {
        meta: { local_last_change_at: await getMeta() },
        municipios: await getTable('municipios'),
        instituciones: await getTable('instituciones'),
        sedes: await getTable('sedes'),
        indicadores: await getTable('indicadores'),
        proyectos: await getTable('proyectos'),
        actividades: await getTable('actividades'),
        seguimientos: await getTable('seguimientos')
    };
}

async function upsertRemoteIntoLocal(remote) {
    if (!remote) return;
    
    return new Promise((resolve) => {
        dbLocal.serialize(() => {
            dbLocal.run("BEGIN TRANSACTION");

            // Limpieza Total para garantizar consistencia con la nube
            if(remote.seguimientos) dbLocal.run("DELETE FROM seguimientos");
            if(remote.actividades) dbLocal.run("DELETE FROM actividades");
            if(remote.proyectos) dbLocal.run("DELETE FROM proyectos");
            // Nota: No borramos catálogos base (municipios/sedes) para no romper IDs, 
            // pero si quisieras réplica exacta podrías hacerlo.
            
            const insertGroup = (table, dataMap) => {
                if (!dataMap) return;
                const items = Object.values(dataMap);
                if (items.length === 0) return;

                // Detectar columnas (omitiendo id local)
                const columns = Object.keys(items[0]).filter(k => k !== 'id');
                const placeholders = columns.map(() => '?').join(',');
                const stmt = dbLocal.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`);

                items.forEach(item => {
                    stmt.run(columns.map(col => item[col]));
                });
                stmt.finalize();
            };

            try {
                // Orden estricto para Foreign Keys
                if(remote.municipios) insertGroup('municipios', remote.municipios);
                if(remote.instituciones) insertGroup('instituciones', remote.instituciones);
                if(remote.sedes) insertGroup('sedes', remote.sedes);
                if(remote.indicadores) insertGroup('indicadores', remote.indicadores);
                
                if(remote.proyectos) insertGroup('proyectos', remote.proyectos);
                if(remote.actividades) insertGroup('actividades', remote.actividades);
                if(remote.seguimientos) insertGroup('seguimientos', remote.seguimientos);

                dbLocal.run("COMMIT", resolve);
            } catch (e) {
                console.error("Error insertando remotos:", e);
                dbLocal.run("ROLLBACK", resolve);
            }
        });
    });
}

module.exports = { startSyncEngine, runBidirectionalSync, touchLocalChange };