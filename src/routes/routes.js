const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const projectController = require('../controllers/projectController');

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

router.get('/', projectController.index);
router.get('/api/search', projectController.search);
router.get('/api/project/:bpin', projectController.getProject);
router.get('/api/activity-details/:activityId', projectController.getActivityDetails); // NUEVA RUTA
router.get('/api/activity-locations/:activityId', projectController.getActivityLocations);

router.get('/api/municipios', projectController.getMunicipios);
router.get('/api/instituciones/:municipioId', projectController.getInstituciones);
router.get('/api/sedes/:institucionId', projectController.getSedes);
router.get('/api/indicadores', projectController.getIndicadores);
router.get('/api/filtros/proyectos', projectController.getProjectsByIndicador);
router.get('/api/filtros/actividades', projectController.getActivitiesByFilters);
router.get('/api/filtros/municipios', projectController.getMunicipiosByFilters);
router.get('/api/filtros/instituciones', projectController.getInstitucionesByFilters);
router.get('/api/filtros/sedes', projectController.getSedesByFilters);

router.post('/api/save', projectController.saveData);
router.post('/api/upload-excel', upload.single('archivoExcel'), projectController.uploadExcel);
router.post('/api/cleanDB', projectController.cleanDB); // NUEVA RUTA PARA LIMPIAR LA BASE DE DATOS
router.get('/api/export-excel', projectController.exportExcel);
router.get('/api/export-excel-template', projectController.exportExcelTemplate);

module.exports = router;