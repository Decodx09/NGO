// ## 1. IMPORTS & INITIALIZATION ##
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));


// ## 2. CONFIGURATION ##

// --- CHANGED: Set new allowed radius ---
const ALLOWED_RADIUS_METERS = 50;

// --- MySQL Database Connection ---
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- Multer Configuration for Photo Uploads ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const teacherId = req.body.teacher_id || 'unknown';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${teacherId}-${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`;
        cb(null, filename);
    }
});
const upload = multer({ storage: storage });


// ## 3. HELPER FUNCTION: GEOLOCATION ##
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in meters
}


// ## 4. API ROUTES ##

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend.html'));
});

// --- LOGIN ROUTES ---
app.post('/login/teacher', async (req, res) => {
    try {
        const { employee_code, password } = req.body;
        if (!employee_code || !password) {
            return res.status(400).json({ error: 'Employee code and password are required.' });
        }
        const sql = 'SELECT id, name, employee_code, password FROM teachers WHERE employee_code = ?';
        const [rows] = await dbPool.execute(sql, [employee_code]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid employee code or password.' });
        }
        const teacher = rows[0];
        if (teacher.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid employee code or password.' });
        }
        const teacherData = { id: teacher.id, name: teacher.name, employee_code: teacher.employee_code };
        res.status(200).json({ success: true, message: 'Login successful.', teacher: teacherData });
    } catch (error) {
        console.error('Error during teacher login:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.post('/login/admin', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (username === adminUser && password === adminPass) {
        res.status(200).json({ success: true, message: 'Admin login successful.' });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }
});


// === TEACHER MANAGEMENT ROUTES (FULL CRUD) ===

app.post('/teachers', async (req, res) => {
    try {
        const { name, email, employee_code, password, latitude, longitude } = req.body; 

        if (!name || !email || !employee_code || !password || latitude === undefined || longitude === undefined) {
            return res.status(400).json({ error: 'Missing required fields: name, email, employee_code, password, latitude, and longitude.' });
        }

        const sql = 'INSERT INTO teachers (name, email, employee_code, password, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)';
        const [result] = await dbPool.execute(sql, [name, email, employee_code, password, latitude, longitude]);

        res.status(201).json({
            message: 'Teacher added successfully!',
            teacherId: result.insertId,
            ...req.body
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A teacher with this email or employee code already exists.' });
        }
        console.error('Error adding teacher:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/teachers', async (req, res) => {
    try {
        const [teachers] = await dbPool.execute('SELECT id, name, email, employee_code, created_at, latitude, longitude FROM teachers ORDER BY name');
        res.status(200).json(teachers);
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/teachers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await dbPool.execute('SELECT id, name, email, employee_code, created_at, latitude, longitude FROM teachers WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }
        res.status(200).json(rows[0]);
    } catch (error) {
        console.error('Error fetching teacher:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.put('/teachers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, employee_code, latitude, longitude } = req.body;

        if (!name && !email && !employee_code && latitude === undefined && longitude === undefined) {
            return res.status(400).json({ error: 'At least one field must be provided for update.' });
        }
        
        const fieldsToUpdate = [];
        const values = [];
        if (name) { fieldsToUpdate.push('name = ?'); values.push(name); }
        if (email) { fieldsToUpdate.push('email = ?'); values.push(email); }
        if (employee_code) { fieldsToUpdate.push('employee_code = ?'); values.push(employee_code); }
        if (latitude !== undefined) { fieldsToUpdate.push('latitude = ?'); values.push(latitude); }
        if (longitude !== undefined) { fieldsToUpdate.push('longitude = ?'); values.push(longitude); }
        values.push(id);

        const sql = `UPDATE teachers SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;
        const [result] = await dbPool.execute(sql, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Teacher not found with the specified ID.' });
        }

        res.status(200).json({ message: 'Teacher details updated successfully.' });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'A teacher with this email or employee code already exists.' });
        }
        console.error('Error updating teacher:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.delete('/teachers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sql = 'DELETE FROM teachers WHERE id = ?';
        const [result] = await dbPool.execute(sql, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }

        res.status(200).json({ message: 'Teacher deleted successfully.' });
    } catch (error) {
        console.error('Error deleting teacher:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// === ATTENDANCE & REPORTING ROUTES ===

app.post('/attendance', upload.fields([{ name: 'photo1', maxCount: 1 }, { name: 'photo2', maxCount: 1 }]), async (req, res) => {
    const photos = req.files;
    const photo1 = photos.photo1 ? photos.photo1[0] : null;
    const photo2 = photos.photo2 ? photos.photo2[0] : null;

    const cleanupFiles = () => {
        try {
            if (photo1 && fs.existsSync(photo1.path)) fs.unlinkSync(photo1.path);
            if (photo2 && fs.existsSync(photo2.path)) fs.unlinkSync(photo2.path);
        } catch (err) {
            console.error("Error cleaning up files:", err);
        }
    };

    try {
        const { teacher_id, latitude, longitude } = req.body;

        if (!teacher_id || !latitude || !longitude || !photo1 || !photo2) {
            cleanupFiles();
            return res.status(400).json({ error: 'Missing required fields: teacher_id, latitude, longitude, and two photos.' });
        }

        const todayDate = new Date().toISOString().slice(0, 10);
        const checkSql = 'SELECT id FROM attendance WHERE teacher_id = ? AND DATE(attendance_time) = ?';
        const [existing] = await dbPool.execute(checkSql, [teacher_id, todayDate]);

        if (existing.length > 0) {
            cleanupFiles();
            return res.status(409).json({ error: 'Attendance has already been marked for today.' });
        }

        const [teacherRows] = await dbPool.execute('SELECT latitude, longitude FROM teachers WHERE id = ?', [teacher_id]);
        
        if (teacherRows.length === 0) {
            cleanupFiles();
            return res.status(404).json({ error: `Teacher with ID ${teacher_id} not found.` });
        }
        
        const teacher = teacherRows[0];
        if (teacher.latitude == null || teacher.longitude == null) {
            cleanupFiles();
            return res.status(400).json({ error: 'Your designated coordinates are not set. Please contact an administrator.' });
        }

        const distance = calculateDistance(
            parseFloat(latitude),
            parseFloat(longitude),
            parseFloat(teacher.latitude),
            parseFloat(teacher.longitude)
        );

        if (distance > ALLOWED_RADIUS_METERS) {
            cleanupFiles();
            return res.status(403).json({
                error: `You are out of the allowed range for attendance.`,
                details: `Your distance from the designated location is ${distance.toFixed(2)}m. The allowed range is ${ALLOWED_RADIUS_METERS}m.`
            });
        }
        
        const photoPath1 = photo1.path;
        const photoPath2 = photo2.path;
        const sql = 'INSERT INTO attendance (teacher_id, photo_path, photo_path2, latitude, longitude) VALUES (?, ?, ?, ?, ?)';
        const [result] = await dbPool.execute(sql, [teacher_id, photoPath1, photoPath2, latitude, longitude]);
        
        res.status(201).json({
            message: 'Attendance marked successfully!',
            attendanceId: result.insertId,
        });

    } catch (error) {
        cleanupFiles();
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
             return res.status(404).json({ error: `Teacher with ID ${req.body.teacher_id} does not exist.` });
        }
        console.error('Error marking attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/today', async (req, res) => {
    try {
        const todayDate = new Date().toISOString().slice(0, 10);
        const sql = `
            SELECT a.id as attendance_id, a.teacher_id, t.name as teacher_name, t.employee_code, 
                   a.attendance_time, a.photo_path, a.photo_path2
            FROM attendance a JOIN teachers t ON a.teacher_id = t.id
            WHERE DATE(a.attendance_time) = ? ORDER BY a.attendance_time DESC
        `;
        const [records] = await dbPool.execute(sql, [todayDate]);

        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            photo_url: record.photo_path ? `/uploads/${path.basename(record.photo_path)}` : null,
            photo_url2: record.photo_path2 ? `/uploads/${path.basename(record.photo_path2)}` : null
        }));
        
        res.status(200).json({ count: records.length, data: recordsWithPhotoUrl });
    } catch (error) {
        console.error('Error fetching today\'s attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/absent', async (req, res) => {
    try {
        const todayDate = new Date().toISOString().slice(0, 10);
        const sql = `
            SELECT t.id, t.name, t.employee_code, t.email
            FROM teachers t
            LEFT JOIN attendance a ON t.id = a.teacher_id AND DATE(a.attendance_time) = ?
            WHERE a.id IS NULL
            ORDER BY t.name
        `;
        const [absentTeachers] = await dbPool.execute(sql, [todayDate]);
        res.status(200).json({ count: absentTeachers.length, data: absentTeachers });
    } catch (error) {
        console.error('Error fetching absent teachers:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/report/all', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Both startDate and endDate query parameters are required (YYYY-MM-DD).' });
        }
        
        const sql = `
            SELECT a.id, a.teacher_id, t.name, t.employee_code, a.attendance_time, a.photo_path, a.photo_path2
            FROM attendance a JOIN teachers t ON a.teacher_id = t.id
            WHERE DATE(a.attendance_time) BETWEEN ? AND ?
            ORDER BY a.attendance_time DESC, t.name
        `;
        const [records] = await dbPool.execute(sql, [startDate, endDate]);

        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            photo_url: record.photo_path ? `/uploads/${path.basename(record.photo_path)}` : null,
            photo_url2: record.photo_path2 ? `/uploads/${path.basename(record.photo_path2)}` : null
        }));

        res.status(200).json({ count: records.length, data: recordsWithPhotoUrl });

    } catch (error) {
        console.error('Error fetching attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/report/teacher/:teacher_id', async (req, res) => {
    try {
        const { teacher_id } = req.params;
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Both startDate and endDate query parameters are required (YYYY-MM-DD).' });
        }

        const sql = `
            SELECT id, attendance_time, photo_path, photo_path2, latitude, longitude 
            FROM attendance 
            WHERE teacher_id = ? AND DATE(attendance_time) BETWEEN ? AND ?
            ORDER BY attendance_time DESC
        `;
        const [records] = await dbPool.execute(sql, [teacher_id, startDate, endDate]);

        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            photo_url: record.photo_path ? `/uploads/${path.basename(record.photo_path)}` : null,
            photo_url2: record.photo_path2 ? `/uploads/${path.basename(record.photo_path2)}` : null
        }));
        
        res.status(200).json({ count: records.length, data: recordsWithPhotoUrl });

    } catch (error) {
        console.error('Error fetching teacher attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/:teacher_id', async (req, res) => {
    try {
        const { teacher_id } = req.params;
        const { filter } = req.query; // 'week' or 'month'

        let sql = 'SELECT id, teacher_id, attendance_time, photo_path, photo_path2, latitude, longitude FROM attendance WHERE teacher_id = ?';
        const params = [teacher_id];

        if (filter === 'week') {
            sql += ' AND attendance_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
        } else if (filter === 'month') {
            sql += ' AND MONTH(attendance_time) = MONTH(NOW()) AND YEAR(attendance_time) = YEAR(NOW())';
        }
        
        sql += ' ORDER BY attendance_time DESC';

        const [records] = await dbPool.execute(sql, params);
        
        if (records.length === 0) {
            return res.status(200).json([]); // Return empty array for consistency
        }

        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            photo_url: record.photo_path ? `/uploads/${path.basename(record.photo_path)}` : null,
            photo_url2: record.photo_path2 ? `/uploads/${path.basename(record.photo_path2)}` : null
        }));

        res.status(200).json(recordsWithPhotoUrl);
        
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// === DASHBOARD ROUTES ===

app.get('/dashboard/stats', async (req, res) => {
    try {
        const todayDate = new Date().toISOString().slice(0, 10);
        
        const [totalResult] = await dbPool.execute('SELECT COUNT(id) as total_teachers FROM teachers');
        const totalTeachers = totalResult[0].total_teachers;

        const [presentResult] = await dbPool.execute('SELECT COUNT(DISTINCT teacher_id) as present_teachers FROM attendance WHERE DATE(attendance_time) = ?', [todayDate]);
        const presentTeachers = presentResult[0].present_teachers;

        const absentTeachers = totalTeachers - presentTeachers;

        res.status(200).json({
            total_teachers: totalTeachers,
            present_today: presentTeachers,
            absent_today: absentTeachers,
            date: todayDate
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// ## 5. START SERVER ##
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

