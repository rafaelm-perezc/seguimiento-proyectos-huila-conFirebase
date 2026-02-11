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
        const localHasSeedCatalogs = Boolean(
            (localData.municipios?.length || 0) > 0 &&
            (localData.instituciones?.length || 0) > 0 &&
            (localData.sedes?.length || 0) > 0 &&
            (localData.indicadores?.length || 0) > 0
        );
        const isNewPcBootstrap = !localHasProjects && localHasSeedCatalogs && remoteHasProjects;

        // CASO 1: Soy un PC nuevo (vacío) y en la nube hay datos -> ¡DESCARGAR SIEMPRE!
        if (isNewPcBootstrap) {
            console.warn("🛡️ DETECTADO: Bootstrap explícito de PC nuevo (catálogos semilla + nube con proyectos). Iniciando réplica segura.");
            await upsertRemoteIntoLocal(remoteData, { bootstrapMode: true });
            await recalculateSyncMetadata(remoteData.meta?.last_change_at);
            console.log("✅ Recuperación de datos completada exitosamente.");
            isSyncing = false;
            return; // ¡IMPORTANTE! Salir aquí para no ejecutar nada más.
        }

        if (!localHasProjects && remoteHasProjects) {
            console.warn("🛡️ DETECTADO: Base local vacía vs Nube con datos. FORZANDO DESCARGA DE SEGURIDAD.");
            await upsertRemoteIntoLocal(remoteData);
            await recalculateSyncMetadata(remoteData.meta?.last_change_at);
            console.log("✅ Recuperación de datos completada exitosamente.");
            isSyncing = false;
            return;
        }

        // CASO 1B: Migración inicial local -> nube (nube vacía)
        if (localHasProjects && !remoteHasProjects) {
            console.warn("🛡️ DETECTADO: Migración inicial local→nube. Publicando toda la base local en Firebase.");

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
            await touchLocalChange();
            console.log("✅ Migración inicial local→nube completada correctamente.");
            isSyncing = false;
            return;
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
            await recalculateSyncMetadata(remoteData.meta?.last_change_at);
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

async function upsertRemoteIntoLocal(remote, options = {}) {
    if (!remote) return;

    const remoteArray = (key) => Object.values(remote[key] || {});
    const normalize = (value) => (value || '').toString().trim().toUpperCase();
    const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
        dbLocal.run(sql, params, function onRun(err) { if (err) reject(err); else resolve(this); });
    });
    const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
        dbLocal.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
        dbLocal.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });

    const upsertCatalogsByNaturalKey = async () => {
        const municipioMap = {};
        const institucionMap = {};
        const sedeMap = {};
        const indicadorMap = {};

        const localMunicipios = await allAsync("SELECT id, nombre FROM municipios");
        const municipioByName = new Map(localMunicipios.map(m => [normalize(m.nombre), m.id]));
        const remoteMunicipios = remoteArray('municipios');
        for (const mun of remoteMunicipios) {
            const munName = normalize(mun.nombre);
            if (!munName) continue;

            let localId = municipioByName.get(munName);
            if (!localId) {
                const insertResult = await runAsync("INSERT INTO municipios (nombre) VALUES (?)", [munName]);
                localId = insertResult.lastID;
                municipioByName.set(munName, localId);
            }
            if (mun.id !== undefined && mun.id !== null) municipioMap[mun.id] = localId;
        }

        const localInstituciones = await allAsync("SELECT id, nombre, municipio_id FROM instituciones");
        const institucionByNatural = new Map(localInstituciones.map(i => [`${normalize(i.nombre)}|${i.municipio_id || ''}`, i.id]));
        const remoteMunicipiosById = new Map(remoteMunicipios.map(m => [m.id, normalize(m.nombre)]));
        const remoteInstituciones = remoteArray('instituciones');
        for (const inst of remoteInstituciones) {
            const instName = normalize(inst.nombre);
            const remoteMunName = remoteMunicipiosById.get(inst.municipio_id);
            const localMunId = municipioMap[inst.municipio_id] || municipioByName.get(remoteMunName);
            if (!instName || !localMunId) continue;

            const key = `${instName}|${localMunId}`;
            let localId = institucionByNatural.get(key);
            if (!localId) {
                const insertResult = await runAsync("INSERT INTO instituciones (nombre, municipio_id) VALUES (?, ?)", [instName, localMunId]);
                localId = insertResult.lastID;
                institucionByNatural.set(key, localId);
            }
            if (inst.id !== undefined && inst.id !== null) institucionMap[inst.id] = localId;
        }

        const localSedes = await allAsync("SELECT id, nombre, institucion_id FROM sedes");
        const sedesByNatural = new Map(localSedes.map(s => [`${normalize(s.nombre)}|${s.institucion_id || ''}`, s.id]));
        const remoteSedes = remoteArray('sedes');
        for (const sede of remoteSedes) {
            const sedeName = normalize(sede.nombre);
            const localInstId = institucionMap[sede.institucion_id];
            if (!sedeName || !localInstId) continue;

            const key = `${sedeName}|${localInstId}`;
            let localId = sedesByNatural.get(key);
            if (!localId) {
                const insertResult = await runAsync("INSERT INTO sedes (nombre, institucion_id) VALUES (?, ?)", [sedeName, localInstId]);
                localId = insertResult.lastID;
                sedesByNatural.set(key, localId);
            }
            if (sede.id !== undefined && sede.id !== null) sedeMap[sede.id] = localId;
        }

        const localIndicadores = await allAsync("SELECT id, nombre FROM indicadores");
        const indicadorByName = new Map(localIndicadores.map(i => [normalize(i.nombre), i.id]));
        const remoteIndicadores = remoteArray('indicadores');
        for (const indicador of remoteIndicadores) {
            const indName = normalize(indicador.nombre);
            if (!indName) continue;

            let localId = indicadorByName.get(indName);
            if (!localId) {
                const insertResult = await runAsync("INSERT INTO indicadores (nombre) VALUES (?)", [indName]);
                localId = insertResult.lastID;
                indicadorByName.set(indName, localId);
            }
            if (indicador.id !== undefined && indicador.id !== null) indicadorMap[indicador.id] = localId;
        }

        return { municipioMap, institucionMap, sedeMap, indicadorMap };
    };

    const insertWithColumns = async (table, item, preferredOrder = []) => {
        const availableColumns = [...new Set([...preferredOrder, ...Object.keys(item)])].filter((k) => item[k] !== undefined);
        if (availableColumns.length === 0) return;
        const placeholders = availableColumns.map(() => '?').join(',');
        await runAsync(
            `INSERT OR REPLACE INTO ${table} (${availableColumns.join(',')}) VALUES (${placeholders})`,
            availableColumns.map((c) => item[c])
        );
    };

    try {
        await runAsync("BEGIN TRANSACTION");
        if (options.bootstrapMode) {
            console.log("🧭 Bootstrap de PC nuevo: aplicando catálogos por llave natural y réplica transaccional completa.");
        }
        const idMaps = await upsertCatalogsByNaturalKey();

        // Transaccionales: réplica completa preservando IDs
        if (remote.proyectos) await runAsync("DELETE FROM proyectos");
        if (remote.actividades) await runAsync("DELETE FROM actividades");
        if (remote.seguimientos) await runAsync("DELETE FROM seguimientos");

        const proyectos = remoteArray('proyectos');
        for (const proyecto of proyectos) {
            await insertWithColumns('proyectos', proyecto, [
                'id', 'codigo_bpin', 'nombre_proyecto', 'anio_contrato', 'contratista',
                'valor_inicial', 'valor_rp', 'valor_sgp', 'valor_men', 'valor_sgr', 'fuente_recursos', 'sync_uid'
            ]);
        }

        const actividades = remoteArray('actividades');
        for (const actividad of actividades) {
            await insertWithColumns('actividades', actividad, ['id', 'proyecto_id', 'descripcion', 'sync_uid']);
        }

        const seguimientos = remoteArray('seguimientos');
        for (const seguimientoRaw of seguimientos) {
            const seguimiento = { ...seguimientoRaw };
            if (seguimiento.sede_id !== undefined && seguimiento.sede_id !== null) {
                seguimiento.sede_id = idMaps.sedeMap[seguimiento.sede_id] || seguimiento.sede_id;
            }
            if (seguimiento.indicador_id !== undefined && seguimiento.indicador_id !== null) {
                seguimiento.indicador_id = idMaps.indicadorMap[seguimiento.indicador_id] || seguimiento.indicador_id;
            }

            let duplicate = null;
            if (seguimiento.sync_uid) {
                duplicate = await getAsync("SELECT id FROM seguimientos WHERE sync_uid = ?", [seguimiento.sync_uid]);
            }

            if (!duplicate) {
                const actividadId = seguimiento.actividad_id ?? null;
                duplicate = await getAsync(
                    `SELECT id FROM seguimientos
                     WHERE proyecto_id = ?
                       AND sede_id = ?
                       AND indicador_id = ?
                       AND fecha_seguimiento = ?
                       AND (actividad_id = ? OR (actividad_id IS NULL AND ? IS NULL))`,
                    [
                        seguimiento.proyecto_id,
                        seguimiento.sede_id,
                        seguimiento.indicador_id,
                        seguimiento.fecha_seguimiento,
                        actividadId,
                        actividadId
                    ]
                );
            }

            if (!duplicate) {
                await insertWithColumns('seguimientos', seguimiento, [
                    'id', 'proyecto_id', 'actividad_id', 'sede_id', 'indicador_id', 'porcentaje_avance',
                    'fecha_seguimiento', 'responsable', 'observaciones', 'es_adicion', 'valor_adicion',
                    'fuente_adicion', 'sync_uid'
                ]);
            }
        }

        await runAsync("COMMIT");
    } catch (e) {
        console.error("Error insertando remotos:", e);
        await runAsync("ROLLBACK");
    }
}

async function recalculateSyncMetadata(remoteTimestamp) {
    const syncedAt = remoteTimestamp || new Date().toISOString();
    const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
        dbLocal.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });

    await runAsync(
        `INSERT INTO app_meta (key, value) VALUES ('local_last_change_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [syncedAt]
    );
    await runAsync(
        `INSERT INTO sync_metadata (key, value) VALUES ('local_last_change_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [syncedAt]
    );
    await runAsync(
        `INSERT INTO sync_metadata (key, value) VALUES ('last_remote_sync_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [new Date().toISOString()]
    );
}

module.exports = { startSyncEngine, runBidirectionalSync, touchLocalChange };