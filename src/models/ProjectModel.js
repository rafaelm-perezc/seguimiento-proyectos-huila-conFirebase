const db = require('../db/database');
const crypto = require('crypto');

const ProjectModel = {
    
    findByBpin: (bpin) => {
        return new Promise((resolve, reject) => {
            if (!bpin) return resolve(null); 
            db.get(`SELECT * FROM proyectos WHERE codigo_bpin = ?`, [bpin], (err, row) => (err ? reject(err) : resolve(row)));
        });
    },

    search: (query) => {
        return new Promise((resolve, reject) => {            
            const param = `%${query}%`;
            db.all(`SELECT * FROM proyectos WHERE codigo_bpin LIKE ? OR nombre_proyecto LIKE ? LIMIT 10`, [param, param], (err, rows) => (err ? reject(err) : resolve(rows)));
        });
    },

    createProject: (data) => {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO proyectos 
                (codigo_bpin, nombre_proyecto, anio_contrato, contratista, valor_inicial, valor_rp, valor_sgp, valor_men, valor_sgr, fuente_recursos, sync_uid) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            let bpinFinal = (data.codigo_bpin && data.codigo_bpin.toString().trim() !== "") ? data.codigo_bpin.toString().trim() : null;
            const params = [
                bpinFinal, data.nombre_proyecto.toUpperCase(), data.anio_contrato, 
                data.contratista ? data.contratista.toUpperCase() : null, 
                data.valor_inicial, data.valor_rp || 0, data.valor_sgp || 0, data.valor_men || 0, data.valor_sgr || 0, 
                data.fuente_recursos ? data.fuente_recursos.toUpperCase() : null,
                data.sync_uid || crypto.randomUUID()
            ];
            db.run(sql, params, function(err) { if (err) reject(err); else resolve(this.lastID); });
        });
    },

    addActivity: (proyectoId, descripcion, syncUid = null) => {
        return new Promise((resolve, reject) => {
            const desc = descripcion.toUpperCase().trim();
            db.get(`SELECT id FROM actividades WHERE proyecto_id = ? AND descripcion = ?`, [proyectoId, desc], (err, row) => {
                if (err) return reject(err);
                if (row) return resolve(row.id);

                const uid = syncUid || crypto.randomUUID();
                db.run(`INSERT INTO actividades (proyecto_id, descripcion, sync_uid) VALUES (?, ?, ?)`, [proyectoId, desc, uid], function(insertErr) {
                    if (insertErr) {
                        if (insertErr.message.includes('UNIQUE')) {
                             db.get(`SELECT id FROM actividades WHERE proyecto_id = ? AND descripcion = ?`, [proyectoId, desc], (retryErr, retryRow) => {
                                 if (retryErr) reject(retryErr); else resolve(retryRow?.id);
                             });
                        } else reject(insertErr);
                    } else resolve(this.lastID);
                });
            });
        });
    },

    getActivitiesByProject: (proyectoId) => new Promise((resolve, reject) => db.all(`SELECT * FROM actividades WHERE proyecto_id = ?`, [proyectoId], (err, rows) => (err ? reject(err) : resolve(rows)))),
    
    getProjectLocations: (proyectoId) => new Promise((resolve, reject) => {
        const sql = `SELECT seg.actividad_id, sed.id as sede_id, sed.nombre as sede_nombre, inst.id as institucion_id, inst.nombre as institucion_nombre,
                    mun.id as municipio_id, mun.nombre as municipio_nombre, seg.porcentaje_avance as ultimo_avance, seg.fecha_seguimiento as ultima_fecha
                FROM seguimientos seg
                JOIN (SELECT sede_id, MAX(id) as max_id FROM seguimientos WHERE proyecto_id = ? GROUP BY sede_id) latest ON seg.id = latest.max_id
                JOIN sedes sed ON seg.sede_id = sed.id
                JOIN instituciones inst ON sed.institucion_id = inst.id
                JOIN municipios mun ON inst.municipio_id = mun.id
                ORDER BY mun.nombre, inst.nombre, sed.nombre`;
        db.all(sql, [proyectoId], (err, rows) => (err ? reject(err) : resolve(rows)));
    }),

    getLocationsByActivity: (actividadId) => new Promise((resolve, reject) => {
        const sql = `SELECT sed.id as sede_id, sed.nombre as sede_nombre, inst.id as institucion_id, inst.nombre as institucion_nombre,
                    mun.id as municipio_id, mun.nombre as municipio_nombre, seg.porcentaje_avance as ultimo_avance, seg.fecha_seguimiento as ultima_fecha
                FROM seguimientos seg
                JOIN (SELECT sede_id, MAX(id) as max_id FROM seguimientos WHERE actividad_id = ? GROUP BY sede_id) latest ON seg.id = latest.max_id
                JOIN sedes sed ON seg.sede_id = sed.id
                JOIN instituciones inst ON sed.institucion_id = inst.id
                JOIN municipios mun ON inst.municipio_id = mun.id
                ORDER BY mun.nombre, inst.nombre, sed.nombre`;
        db.all(sql, [actividadId], (err, rows) => (err ? reject(err) : resolve(rows)));
    }),

    getLastTrackingByActivity: (actividadId) => new Promise((resolve, reject) => {
        db.get(`SELECT s.actividad_id, s.sede_id, s.indicador_id, s.responsable, s.observaciones, sed.institucion_id, inst.municipio_id
                FROM seguimientos s LEFT JOIN sedes sed ON s.sede_id = sed.id LEFT JOIN instituciones inst ON sed.institucion_id = inst.id
                WHERE s.actividad_id = ? ORDER BY s.id DESC LIMIT 1`, [actividadId], (err, row) => (err ? reject(err) : resolve(row)));
    }),

    createMunicipio: (nombre) => new Promise((resolve, reject) => db.run(`INSERT INTO municipios (nombre) VALUES (?)`, [nombre.toUpperCase()], function(err) { if (err) reject(err); else resolve(this.lastID); })),
    createInstitucion: (nombre, munId) => new Promise((resolve, reject) => db.run(`INSERT INTO instituciones (nombre, municipio_id) VALUES (?, ?)`, [nombre.toUpperCase(), munId], function(err) { if (err) reject(err); else resolve(this.lastID); })),
    createSede: (nombre, instId) => new Promise((resolve, reject) => db.run(`INSERT INTO sedes (nombre, institucion_id) VALUES (?, ?)`, [nombre.toUpperCase(), instId], function(err) { if (err) reject(err); else resolve(this.lastID); })),

    addSeguimiento: (data) => {
        return new Promise((resolve, reject) => {
            // Verificar existencia para evitar duplicados (UPSERT LÓGICO)
            const sqlCheck = `SELECT id FROM seguimientos WHERE proyecto_id = ? AND sede_id = ? AND fecha_seguimiento = ? AND (actividad_id IS ? OR actividad_id = ?)`;
            const actId = data.actividad_id || null;
            
            db.get(sqlCheck, [data.proyecto_id, data.sede_id, data.fecha_seguimiento, actId, actId], (err, row) => {
                if (err) return reject(err);
                if (row) {
                    // Actualizar existente
                    const sqlUpdate = `UPDATE seguimientos SET porcentaje_avance = ?, responsable = ?, observaciones = ?, es_adicion = ?, valor_adicion = ?, fuente_adicion = ? WHERE id = ?`;
                    db.run(sqlUpdate, [
                        data.porcentaje_avance, data.responsable.toUpperCase(), data.observaciones ? data.observaciones.toUpperCase() : '',
                        data.es_adicion ? 1 : 0, data.valor_adicion || 0, data.fuente_adicion ? data.fuente_adicion.toUpperCase() : null, row.id
                    ], function(err) { if (err) reject(err); else resolve(row.id); });
                } else {
                    // Insertar nuevo
                    const sqlInsert = `INSERT INTO seguimientos (sync_uid, proyecto_id, actividad_id, sede_id, indicador_id, porcentaje_avance, fecha_seguimiento, responsable, observaciones, es_adicion, valor_adicion, fuente_adicion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                    db.run(sqlInsert, [
                        data.sync_uid || crypto.randomUUID(), data.proyecto_id, actId, data.sede_id, data.indicador_id,
                        data.porcentaje_avance, data.fecha_seguimiento, data.responsable.toUpperCase(), data.observaciones ? data.observaciones.toUpperCase() : '',
                        data.es_adicion ? 1 : 0, data.valor_adicion || 0, data.fuente_adicion ? data.fuente_adicion.toUpperCase() : null
                    ], function(err) { if (err) reject(err); else resolve(this.lastID); });
                }
            });
        });
    },

    getAllMunicipios: () => new Promise((resolve, reject) => db.all("SELECT * FROM municipios ORDER BY nombre", [], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getInstitucionesByMunicipio: (id) => new Promise((resolve, reject) => db.all("SELECT * FROM instituciones WHERE municipio_id = ? ORDER BY nombre", [id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getSedesByInstitucion: (id) => new Promise((resolve, reject) => db.all("SELECT * FROM sedes WHERE institucion_id = ? ORDER BY nombre", [id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getAllIndicadores: () => new Promise((resolve, reject) => db.all("SELECT * FROM indicadores ORDER BY nombre", [], (err, rows) => (err ? reject(err) : resolve(rows)))),
    
    getAllDataForExport: () => new Promise((resolve, reject) => {
        db.all(`SELECT p.codigo_bpin, i.nombre as indicador, p.anio_contrato, p.nombre_proyecto, a.descripcion as actividad, p.contratista, 
                m.nombre as municipio, inst.nombre as institucion, s.nombre as sede, p.valor_inicial, p.valor_rp, p.valor_sgp, p.valor_men, p.valor_sgr,
                seg.valor_adicion, seg.fuente_adicion, seg.porcentaje_avance, seg.fecha_seguimiento, seg.responsable, seg.observaciones
            FROM seguimientos seg JOIN proyectos p ON seg.proyecto_id = p.id LEFT JOIN actividades a ON seg.actividad_id = a.id
            LEFT JOIN sedes s ON seg.sede_id = s.id LEFT JOIN instituciones inst ON s.institucion_id = inst.id LEFT JOIN municipios m ON inst.municipio_id = m.id
            LEFT JOIN indicadores i ON seg.indicador_id = i.id ORDER BY seg.id DESC`, [], (err, rows) => (err ? reject(err) : resolve(rows)));
    }),

    getGeneralStats: (filters = {}) => new Promise((resolve, reject) => {
        // ... (Tu código de stats original) ...
        const whereClauses = []; const params = [];
        if (filters.indicador_id) { whereClauses.push('s.indicador_id = ?'); params.push(filters.indicador_id); }
        if (filters.proyecto_id) { whereClauses.push('s.proyecto_id = ?'); params.push(filters.proyecto_id); }
        // ... Agrega el resto de filtros igual que antes ...
        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const sql = `WITH seguimientos_filtrados AS ( SELECT s.* FROM seguimientos s LEFT JOIN sedes sed ON s.sede_id = sed.id LEFT JOIN instituciones inst ON sed.institucion_id = inst.id LEFT JOIN municipios m ON inst.municipio_id = m.id ${whereSql} )
            SELECT (SELECT COUNT(DISTINCT proyecto_id) FROM seguimientos_filtrados) as total_proyectos,
                (SELECT COALESCE(SUM(p.valor_inicial), 0) FROM proyectos p WHERE p.id IN (SELECT DISTINCT proyecto_id FROM seguimientos_filtrados)) as total_inversion,
                (SELECT COUNT(DISTINCT sede_id) FROM seguimientos_filtrados WHERE sede_id IS NOT NULL) as total_sedes,
                (SELECT COALESCE(AVG(porcentaje_avance), 0) FROM seguimientos_filtrados) as promedio_avance_global`;
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || { total_proyectos: 0, total_inversion: 0, total_sedes: 0, promedio_avance_global: 0 })));
    }),

    getProjectsByIndicador: (id) => new Promise((resolve, reject) => db.all(`SELECT DISTINCT p.id, p.nombre_proyecto as nombre FROM seguimientos s JOIN proyectos p ON s.proyecto_id = p.id WHERE s.indicador_id = ? ORDER BY p.nombre_proyecto`, [id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getActivitiesByIndicatorProject: (indId, proyId) => new Promise((resolve, reject) => db.all(`SELECT DISTINCT a.id, a.descripcion as nombre FROM seguimientos s JOIN actividades a ON s.actividad_id = a.id WHERE s.indicador_id = ? AND s.proyecto_id = ? ORDER BY a.descripcion`, [indId, proyId], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getMunicipiosByFilters: (f) => new Promise((resolve, reject) => db.all(`SELECT DISTINCT m.id, m.nombre FROM seguimientos s JOIN sedes sed ON s.sede_id = sed.id JOIN instituciones inst ON sed.institucion_id = inst.id JOIN municipios m ON inst.municipio_id = m.id WHERE s.indicador_id = ? AND s.proyecto_id = ? AND s.actividad_id = ? ORDER BY m.nombre`, [f.indicador_id, f.proyecto_id, f.actividad_id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getInstitucionesByFilters: (f) => new Promise((resolve, reject) => db.all(`SELECT DISTINCT inst.id, inst.nombre FROM seguimientos s JOIN sedes sed ON s.sede_id = sed.id JOIN instituciones inst ON sed.institucion_id = inst.id JOIN municipios m ON inst.municipio_id = m.id WHERE s.indicador_id = ? AND s.proyecto_id = ? AND s.actividad_id = ? AND m.id = ? ORDER BY inst.nombre`, [f.indicador_id, f.proyecto_id, f.actividad_id, f.municipio_id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    getSedesByFilters: (f) => new Promise((resolve, reject) => db.all(`SELECT DISTINCT sed.id, sed.nombre FROM seguimientos s JOIN sedes sed ON s.sede_id = sed.id JOIN instituciones inst ON sed.institucion_id = inst.id WHERE s.indicador_id = ? AND s.proyecto_id = ? AND s.actividad_id = ? AND inst.id = ? ORDER BY sed.nombre`, [f.indicador_id, f.proyecto_id, f.actividad_id, f.institucion_id], (err, rows) => (err ? reject(err) : resolve(rows)))),
    
    getEvolutionData: (filters) => new Promise((resolve, reject) => {
        let sql = `SELECT s.fecha_seguimiento, AVG(s.porcentaje_avance) as avance_promedio FROM seguimientos s JOIN proyectos p ON s.proyecto_id = p.id LEFT JOIN sedes sed ON s.sede_id = sed.id LEFT JOIN instituciones inst ON sed.institucion_id = inst.id LEFT JOIN municipios m ON inst.municipio_id = m.id WHERE 1=1`;
        const params = [];
        if (filters.indicador_id) { sql += " AND s.indicador_id = ?"; params.push(filters.indicador_id); }
        if (filters.proyecto_id) { sql += " AND s.proyecto_id = ?"; params.push(filters.proyecto_id); }
        // ... (Resto de filtros) ...
        sql = sql.replace('AVG(s.porcentaje_avance) as avance_promedio', `AVG(s.porcentaje_avance) as avance_promedio, GROUP_CONCAT(DISTINCT CASE WHEN s.observaciones IS NOT NULL AND TRIM(s.observaciones) <> '' THEN TRIM(s.observaciones) END) as comentarios`);
        sql += ` GROUP BY s.fecha_seguimiento ORDER BY substr(s.fecha_seguimiento, 7, 4) || '-' || substr(s.fecha_seguimiento, 4, 2) || '-' || substr(s.fecha_seguimiento, 1, 2) ASC`;
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    }),

    cleanDatabase: () => new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run("DELETE FROM seguimientos"); db.run("DELETE FROM actividades"); db.run("DELETE FROM proyectos", (err) => {
                if (err) { db.run("ROLLBACK"); return reject(err); }
                db.run("COMMIT", (commitErr) => (commitErr ? reject(commitErr) : resolve()));
            });
        });
    })
};

module.exports = ProjectModel;