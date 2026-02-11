const ProjectModel = require('../models/ProjectModel');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { runBidirectionalSync, touchLocalChange } = require('../services/firebaseSyncService');

// 1. Limpiador para DATOS
const cleanData = (str) => {
    if (!str) return "";
    return str.toString().trim().toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
};

// 2. Limpiador para ENCABEZADOS DE EXCEL
const normalizeHeader = (row) => {
    const newRow = {};
    Object.keys(row).forEach(key => {
        const cleanKey = key.toString().replace(/\s+/g, '').toUpperCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        newRow[cleanKey] = row[key];
    });
    return newRow;
};

const EXPORT_HEADERS = [
    "CÓDIGO BPIN", "AÑO CONTRATO", "NOMBRE DEL PROYECTO", "CONTRATISTA",
    "ACTIVIDAD", "MUNICIPIO", "INSTITUCIÓN", "SEDE", "INDICADOR",
    "VALOR TOTAL INICIAL", "VALOR R.P.", "VALOR S.G.P.", "VALOR MEN", "VALOR S.G.R.",
    "FUENTE RECURSOS (TEXTO)", "ES ADICIÓN", "VALOR ADICIÓN", "FUENTE ADICIÓN",
    "% AVANCE", "FECHA SEGUIMIENTO", "RESPONSABLE", "OBSERVACIONES"
];

const controller = {

    index: (req, res) => { res.sendFile(path.resolve(__dirname, '../../views/index.html')); },
    statsView: (req, res) => { res.sendFile(path.resolve(__dirname, '../../views/stats.html')); },

    // --- GETTERS ---
    search: async (req, res) => { try { const q = req.query.q; if (!q) return res.json([]); res.json(await ProjectModel.search(q)); } catch (e) { res.status(500).json({ error: 'Error búsqueda' }); } },
    
    getProject: async (req, res) => {
        try {
            const p = await ProjectModel.search(req.params.bpin);
            if (p) {
                const a = await ProjectModel.getActivitiesByProject(p[0].id);
                const locations = await ProjectModel.getProjectLocations(p[0].id);
                res.json({ found: true, project: p[0], activities: a, locations });
            } else {
                res.json({ found: false });
            }
        } catch (e) { res.status(500).json({ error: 'Error al obtener proyecto' }); }
    },
    
    getActivityDetails: async (req, res) => { try { res.json(await ProjectModel.getLastTrackingByActivity(req.params.activityId) || {}); } catch (e) { res.status(500).json({ error: e.message }); } },
    getActivityLocations: async (req, res) => { try { res.json(await ProjectModel.getLocationsByActivity(req.params.activityId)); } catch (e) { res.status(500).json({ error: e.message }); } },
    
    getMunicipios: async (req, res) => { try { res.json(await ProjectModel.getAllMunicipios()); } catch (e) { res.status(500).json({error:e.message}); } },
    getInstituciones: async (req, res) => { try { res.json(await ProjectModel.getInstitucionesByMunicipio(req.params.municipioId)); } catch (e) { res.status(500).json({error:e.message}); } },
    getSedes: async (req, res) => { try { res.json(await ProjectModel.getSedesByInstitucion(req.params.institucionId)); } catch (e) { res.status(500).json({error:e.message}); } },
    getIndicadores: async (req, res) => { try { res.json(await ProjectModel.getAllIndicadores()); } catch (e) { res.status(500).json({error:e.message}); } },

    // --- GUARDAR DATOS (FORMULARIO WEB) ---
    saveData: async (req, res) => {
        try {
            const data = req.body;
            
            // 1. PROYECTO
            let projectId = data.proyecto_id;
            const vrp = parseFloat(data.valor_rp) || 0;
            const vsgp = parseFloat(data.valor_sgp) || 0;
            const vmen = parseFloat(data.valor_men) || 0;
            const vsgr = parseFloat(data.valor_sgr) || 0;
            const vTotalManual = parseFloat(data.valor_total_manual) || 0;
            const sumaComponentes = vrp + vsgp + vmen + vsgr;
            const valorInicialFinal = sumaComponentes > 0 ? sumaComponentes : vTotalManual;

            let fuenteStr = "";
            if (sumaComponentes > 0) {
                let fuentes = [];
                if(vrp > 0) fuentes.push("R.P.");
                if(vsgp > 0) fuentes.push("S.G.P.");
                if(vmen > 0) fuentes.push("MEN");
                if(vsgr > 0) fuentes.push("S.G.R.");
                fuenteStr = fuentes.join(' + ');
            } else {
                fuenteStr = data.fuente_recursos_manual ? data.fuente_recursos_manual.toUpperCase() : "SIN DEFINIR";
            }

            if (!projectId) {
                let existingProject = null;
                if (data.codigo_bpin) existingProject = await ProjectModel.findByBpin(data.codigo_bpin);
                if (!existingProject && data.nombre_proyecto) {
                    const searchResults = await ProjectModel.search(data.nombre_proyecto);
                    existingProject = searchResults.find(p => cleanData(p.nombre_proyecto) === cleanData(data.nombre_proyecto));
                }

                if (existingProject) { 
                    projectId = existingProject.id; 
                } else {
                    projectId = await ProjectModel.createProject({
                        codigo_bpin: data.codigo_bpin,
                        nombre_proyecto: data.nombre_proyecto,
                        anio_contrato: data.anio_contrato,
                        contratista: data.contratista,
                        valor_inicial: valorInicialFinal,
                        valor_rp: vrp, valor_sgp: vsgp, valor_men: vmen, valor_sgr: vsgr,
                        fuente_recursos: fuenteStr,
                        sync_uid: crypto.randomUUID()
                    });
                }
            }

            // 2. ACTIVIDAD
            let globalActivityId = data.actividad_id;
            if (globalActivityId === 'new_activity') {
                if (data.nueva_actividad_descripcion) {
                    const acts = await ProjectModel.getActivitiesByProject(projectId);
                    const existAct = acts.find(a => cleanData(a.descripcion) === cleanData(data.nueva_actividad_descripcion));
                    if(existAct) globalActivityId = existAct.id;
                    else globalActivityId = await ProjectModel.addActivity(projectId, data.nueva_actividad_descripcion, crypto.randomUUID());
                } else { return res.status(400).json({ error: 'Falta descripción de nueva actividad.' }); }
            }

            // 3. UBICACIONES
            const ubicaciones = JSON.parse(data.ubicaciones || "[]");
            if (ubicaciones.length === 0) return res.status(400).json({ error: 'Debes agregar al menos una sede.' });

            for (const loc of ubicaciones) {
                let mId = loc.municipio_id;
                let iId = loc.institucion_id;
                let sId = loc.sede_id;

                if (String(mId).startsWith('new_')) {
                    const munName = cleanData(loc.nombre_municipio_nuevo);
                    const allMuns = await ProjectModel.getAllMunicipios();
                    const existM = allMuns.find(m => cleanData(m.nombre) === munName);
                    if(existM) mId = existM.id;
                    else mId = await ProjectModel.createMunicipio(munName);
                }

                if (String(iId).startsWith('new_')) {
                    const instName = cleanData(loc.nombre_institucion_nueva);
                    const allInsts = await ProjectModel.getInstitucionesByMunicipio(mId);
                    const existI = allInsts.find(i => cleanData(i.nombre) === instName);
                    if(existI) iId = existI.id;
                    else iId = await ProjectModel.createInstitucion(instName, mId);
                }

                if (String(sId).startsWith('new_')) {
                    const sedeName = cleanData(loc.nombre_sede_nueva);
                    const allSedes = await ProjectModel.getSedesByInstitucion(iId);
                    const existS = allSedes.find(s => cleanData(s.nombre) === sedeName);
                    if(existS) sId = existS.id;
                    else sId = await ProjectModel.createSede(sedeName, iId);
                }

                await ProjectModel.addSeguimiento({
                    proyecto_id: projectId,
                    actividad_id: globalActivityId,
                    sede_id: sId,
                    indicador_id: data.indicador_id,
                    porcentaje_avance: loc.avance,
                    fecha_seguimiento: data.fecha_seguimiento,
                    responsable: data.responsable,
                    observaciones: loc.observaciones,
                    es_adicion: data.es_adicion === 'on' ? 1 : 0,
                    valor_adicion: data.valor_adicion || 0,
                    fuente_adicion: data.fuente_adicion || null,
                    sync_uid: null // El modelo decidirá si crear o actualizar
                });
            }

            await touchLocalChange();
            runBidirectionalSync();
            res.json({ success: true, message: `Guardado correctamente en ${ubicaciones.length} sedes.` });
        } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    },

    // --- CARGA MASIVA EXCEL ---
    uploadExcel: async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No se subió archivo.' });
        try {
            const workbook = xlsx.readFile(req.file.path);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawRows = xlsx.utils.sheet_to_json(sheet);
            let count = 0; const errors = [];
            
            const indicadores = await ProjectModel.getAllIndicadores();
            
            for (const [index, rawRow] of rawRows.entries()) {
                const rowNum = index + 2; 
                try {
                    const row = normalizeHeader(rawRow);
                    
                    let rawBpin = String(row['CODIGOBPIN'] || '').trim();
                    const codigo_bpin = rawBpin === '' ? null : rawBpin;

                    if (!codigo_bpin && !row['NOMBREDELPROYECTO']) continue; // Fila vacía

                    // 1. PROYECTO
                    let projectId;
                    let existingProject = null;

                    if (codigo_bpin) existingProject = await ProjectModel.findByBpin(codigo_bpin);
                    if (!existingProject && row['NOMBREDELPROYECTO']) {
                        const searchResults = await ProjectModel.search(row['NOMBREDELPROYECTO']);
                        existingProject = searchResults.find(p => cleanData(p.nombre_proyecto) === cleanData(row['NOMBREDELPROYECTO']));
                    }

                    if (existingProject) { 
                        projectId = existingProject.id; 
                    } else {
                        const rp = parseFloat(row['VALORRP'] || row['VALORR.P.'] || 0);
                        const sgp = parseFloat(row['VALORSGP'] || row['VALORS.G.P.'] || 0);
                        let men = parseFloat(row['VALORMEN'] || row['VALORM.E.N.'] || 0);
                        const cofin = parseFloat(row['VALORCOFINANCIACION'] || row['VALORCOFINANCIACIONNACIONAL'] || 0);
                        const sgr = parseFloat(row['VALORSGR'] || row['VALORS.G.R.'] || row['VALORREGALIAS'] || 0);

                        let fuentesTexto = [];
                        if (rp > 0) fuentesTexto.push("R.P.");
                        if (sgp > 0) fuentesTexto.push("S.G.P.");
                        if (men > 0) fuentesTexto.push("MEN");
                        if (cofin > 0) { fuentesTexto.push("COFINANCIACIÓN NACIONAL"); men += cofin; }
                        if (sgr > 0) fuentesTexto.push("S.G.R.");

                        projectId = await ProjectModel.createProject({
                            codigo_bpin: codigo_bpin,
                            nombre_proyecto: row['NOMBREDELPROYECTO'],
                            anio_contrato: row['ANOCONTRATO'] || 0,
                            contratista: row['CONTRATISTA'],
                            valor_inicial: rp + sgp + men + sgr,
                            valor_rp: rp, valor_sgp: sgp, valor_men: men, valor_sgr: sgr,
                            fuente_recursos: fuentesTexto.join(" + ") || "SIN DEFINIR",
                            sync_uid: null // Generar UUID
                        });
                    }

                    // 2. ACTIVIDAD (CORREGIDO EL NOMBRE DEL ENCABEZADO)
                    const descActividad = row['ACTIVIDADESACONTRATAR'] || row['ACTIVIDAD']; // <--- ¡AQUÍ ESTABA EL ERROR!
                    let activityId = null;
                    
                    if (descActividad) {
                        const existingActivities = await ProjectModel.getActivitiesByProject(projectId);
                        const foundAct = existingActivities.find(a => cleanData(a.descripcion) === cleanData(descActividad));
                        if (foundAct) activityId = foundAct.id;
                        else activityId = await ProjectModel.addActivity(projectId, descActividad, null);
                    }

                    // 3. UBICACIÓN
                    const munName = cleanData(row['MUNICIPIO']);
                    const instName = cleanData(row['INSTITUCIONEDUCATIVABENEFICIADA'] || row['INSTITUCION']);
                    const sedeName = cleanData(row['SEDEINSTITUCIONEDUCATIVABENEFICIADA'] || row['SEDE']);
                    
                    let municipioId = null, institucionId = null, sedeId = null;

                    if (munName) {
                        const allMunis = await ProjectModel.getAllMunicipios();
                        const munFound = allMunis.find(m => cleanData(m.nombre) === munName);
                        municipioId = munFound ? munFound.id : await ProjectModel.createMunicipio(munName);

                        if (municipioId && instName) {
                            const allInsts = await ProjectModel.getInstitucionesByMunicipio(municipioId);
                            const instFound = allInsts.find(i => cleanData(i.nombre) === instName);
                            institucionId = instFound ? instFound.id : await ProjectModel.createInstitucion(instName, municipioId);
                        }

                        if (institucionId && sedeName) {
                            const allSedes = await ProjectModel.getSedesByInstitucion(institucionId);
                            const sedeFound = allSedes.find(s => cleanData(s.nombre) === sedeName);
                            sedeId = sedeFound ? sedeFound.id : await ProjectModel.createSede(sedeName, institucionId);
                        }
                    }

                    // 4. INDICADOR
                    const indName = cleanData(row['INDICADOR']);
                    let indicadorId = indicadores.find(i => cleanData(i.nombre) === indName)?.id;

                    // 5. SEGUIMIENTO (UPSERT)
                    let fecha = row['FECHASEGUIMIENTO'];
                    if (typeof fecha === 'number') {
                        const dateObj = xlsx.SSF.parse_date_code(fecha);
                        fecha = `${dateObj.d}/${dateObj.m}/${dateObj.y}`;
                    } else if(!fecha) { const now = new Date(); fecha = `${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}`; }
                    
                    const avance = row['%AVANCEFISICO'] || row['%DEAVANCE'] || 0;
                    const valorAdicion = parseFloat(row['ADICIONDERECURSOS2026'] || row['VALORADICION'] || 0);

                    await ProjectModel.addSeguimiento({
                        proyecto_id: projectId, actividad_id: activityId, sede_id: sedeId, indicador_id: indicadorId,
                        porcentaje_avance: avance, fecha_seguimiento: fecha, responsable: row['RESPONSABLE'],
                        observaciones: row['OBSERVACIONES'], 
                        es_adicion: valorAdicion > 0 ? 1 : 0, valor_adicion: valorAdicion, 
                        fuente_adicion: row['FUENTEADICION'] || '',
                        sync_uid: null
                    });
                    count++;
                } catch (errRow) { errors.push(`Fila ${rowNum}: ${errRow.message}`); }
            }
            fs.unlinkSync(req.file.path);
            await touchLocalChange();
            runBidirectionalSync();
            res.json({ success: true, message: `Procesados ${count}.`, errors: errors });
        } catch (error) { res.status(500).json({ error: 'Error procesando Excel.' }); }
    },

    // --- REPORTES Y GRÁFICAS ---
    exportExcel: async (req, res) => {
        try {
            const rawData = await ProjectModel.getAllDataForExport();
            const data = rawData.map(row => ({
                "CÓDIGO BPIN": row.codigo_bpin,
                "AÑO CONTRATO": row.anio_contrato,
                "NOMBRE DEL PROYECTO": row.nombre_proyecto,
                "CONTRATISTA": row.contratista,
                "ACTIVIDAD": row.actividad,
                "MUNICIPIO": row.municipio,
                "INSTITUCIÓN": row.institucion,
                "SEDE": row.sede,
                "INDICADOR": row.indicador,
                "VALOR TOTAL INICIAL": row.valor_inicial,
                "VALOR R.P.": row.valor_rp,
                "VALOR S.G.P.": row.valor_sgp,
                "VALOR MEN": row.valor_men,
                "VALOR S.G.R.": row.valor_sgr,
                "FUENTE RECURSOS (TEXTO)": row.fuente_recursos,
                "ES ADICIÓN": row.valor_adicion > 0 ? "SÍ" : "NO",
                "VALOR ADICIÓN": row.valor_adicion,
                "FUENTE ADICIÓN": row.fuente_adicion,
                "% AVANCE": row.porcentaje_avance,
                "FECHA SEGUIMIENTO": row.fecha_seguimiento,
                "RESPONSABLE": row.responsable,
                "OBSERVACIONES": row.observaciones
            }));
            const ws = xlsx.utils.json_to_sheet(data, { header: EXPORT_HEADERS, skipHeader: false });
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, ws, "Seguimiento");
            const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', 'attachment; filename="Reporte_Proyectos_Huila.xlsx"');
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);
        } catch (error) { res.status(500).send('Error generando el reporte.'); }
    },

    exportExcelTemplate: async (req, res) => { /* Código plantilla sin cambios */ },

    cleanDB: async (req, res) => {
        if (process.env.ALLOW_DB_CLEAN !== 'true') return res.status(403).json({ success: false, error: 'Operación no permitida' });
        try {
            await ProjectModel.cleanDatabase();
            await touchLocalChange();
            runBidirectionalSync();
            return res.status(200).json({ success: true, message: 'Base de datos limpiada correctamente.' });
        } catch (error) { return res.status(500).json({ success: false, error: 'Error interno' }); }
    },

    // --- API PARA GRÁFICAS ---
    getProjectsByIndicador: async (req, res) => { try { res.json(await ProjectModel.getProjectsByIndicador(req.query.indicador_id)); } catch (e) { res.status(500).json({ error: e.message }); } },
    getActivitiesByFilters: async (req, res) => { try { res.json(await ProjectModel.getActivitiesByIndicatorProject(req.query.indicador_id, req.query.proyecto_id)); } catch (e) { res.status(500).json({ error: e.message }); } },
    getMunicipiosByFilters: async (req, res) => { try { res.json(await ProjectModel.getMunicipiosByFilters(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } },
    getInstitucionesByFilters: async (req, res) => { try { res.json(await ProjectModel.getInstitucionesByFilters(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } },
    getSedesByFilters: async (req, res) => { try { res.json(await ProjectModel.getSedesByFilters(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } },
    apiGetGeneralStats: async (req, res) => { try { res.json(await ProjectModel.getGeneralStats(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } },
    apiGetEvolution: async (req, res) => { try { res.json(await ProjectModel.getEvolutionData(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } },
};

module.exports = controller;