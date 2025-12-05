const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('!!! UNCAUGHT EXCEPTION !!!');
    console.error(err.stack || err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('!!! UNHANDLED PROMISE REJECTION !!!');
    console.error('At:', promise);
    console.error('Reason:', reason.stack || reason);
    process.exit(1);
});
// --- END NEW: GLOBAL ERROR HANDLERS ---


const app = express();
let currentAdminToken = null;
const port = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));


// ## 2. CONFIGURATION ##

// --- Set allowed radius ---
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
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const teacherId = req.body.teacher_id || 'unknown';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        // NEW: Add action type to filename
        const action = req.attendanceAction || 'photo'; // 'check_in' or 'check_out'
        const filename = `${teacherId}-${action}-${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`;
        cb(null, filename);
    }
});
const upload = multer({ storage: storage });


// ## 3. HELPER FUNCTION: GEOLocation ##
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
        // MODIFIED: Select new location fields
        const sql = 'SELECT id, name, employee_code, password, latitude, longitude FROM teachers WHERE employee_code = ?';
        const [rows] = await dbPool.execute(sql, [employee_code]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid employee code or password.' });
        }
        const teacher = rows[0];
        if (teacher.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid employee code or password.' });
        }
        // MODIFIED: Return location data
        const teacherData = {
            id: teacher.id,
            name: teacher.name,
            employee_code: teacher.employee_code,
            latitude: teacher.latitude,
            longitude: teacher.longitude
        };
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
        currentAdminToken = crypto.randomBytes(32).toString('hex');
        res.status(200).json({ success: true, message: 'Admin login successful.', token: currentAdminToken });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }
});


// --- ADMIN AUTH MIDDLEWARE ---
const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token || token !== currentAdminToken) {
        return res.status(401).json({ error: 'Unauthorized: Admin access required.' });
    }
    next();
};

// --- STUDENT MANAGEMENT ROUTES ---
app.post('/students', authenticateAdmin, async (req, res) => {
    try {
        const { first_name, last_name, village_id, age } = req.body;
        if (!first_name || !last_name || !village_id || !age) {
            return res.status(400).json({ error: 'Missing required fields: first_name, last_name, village_id, age.' });
        }

        const sql = 'INSERT INTO students (first_name, last_name, village_id, age) VALUES (?, ?, ?, ?)';
        const [result] = await dbPool.execute(sql, [first_name, last_name, village_id, age]);

        res.status(201).json({
            message: 'Student added successfully!',
            studentId: result.insertId,
            first_name, last_name, village_id, age
        });
    } catch (error) {
        console.error('Error adding student:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/students', authenticateAdmin, async (req, res) => {
    try {
        const { village_id } = req.query;
        let sql = `
            SELECT s.id, s.first_name, s.last_name, s.age, s.village_id, v.village_name 
            FROM students s 
            LEFT JOIN villages v ON s.village_id = v.id 
        `;

        const params = [];
        if (village_id) {
            sql += ' WHERE s.village_id = ?';
            params.push(village_id);
        }

        sql += ' ORDER BY s.first_name, s.last_name';

        const [students] = await dbPool.execute(sql, params);
        res.status(200).json(students);
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/students/:id/attendance', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const sql = `
            SELECT sa.date, sa.status, t.name as teacher_name
            FROM student_attendance sa
            LEFT JOIN teachers t ON sa.teacher_id = t.id
            WHERE sa.student_id = ?
            ORDER BY sa.date DESC
        `;
        const [attendance] = await dbPool.execute(sql, [id]);
        res.status(200).json(attendance);
    } catch (error) {
        console.error('Error fetching student attendance history:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.put('/students/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { first_name, last_name, village_id, age } = req.body;

        if (!first_name && !last_name && !village_id && !age) {
            return res.status(400).json({ error: 'At least one field must be provided for update.' });
        }

        const fieldsToUpdate = [];
        const values = [];
        if (first_name) { fieldsToUpdate.push('first_name = ?'); values.push(first_name); }
        if (last_name) { fieldsToUpdate.push('last_name = ?'); values.push(last_name); }
        if (village_id) { fieldsToUpdate.push('village_id = ?'); values.push(village_id); }
        if (age) { fieldsToUpdate.push('age = ?'); values.push(age); }
        values.push(id);

        const sql = `UPDATE students SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;
        const [result] = await dbPool.execute(sql, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found.' });
        }

        res.status(200).json({ message: 'Student updated successfully.' });
    } catch (error) {
        console.error('Error updating student:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.delete('/students/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const sql = 'DELETE FROM students WHERE id = ?';
        const [result] = await dbPool.execute(sql, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found.' });
        }

        res.status(200).json({ message: 'Student deleted successfully.' });
    } catch (error) {
        console.error('Error deleting student:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- VILLAGE MANAGEMENT ROUTES ---
app.post('/villages', authenticateAdmin, async (req, res) => {
    try {
        const { village_name, state, pincode } = req.body;
        if (!village_name || !state || !pincode) {
            return res.status(400).json({ error: 'Missing required fields: village_name, state, pincode.' });
        }

        const sql = 'INSERT INTO villages (village_name, state, pincode) VALUES (?, ?, ?)';
        const [result] = await dbPool.execute(sql, [village_name, state, pincode]);

        res.status(201).json({
            message: 'Village added successfully!',
            villageId: result.insertId,
            village_name, state, pincode
        });
    } catch (error) {
        console.error('Error adding village:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/villages', authenticateAdmin, async (req, res) => {
    try {
        const [villages] = await dbPool.execute('SELECT * FROM villages ORDER BY village_name');
        res.status(200).json(villages);
    } catch (error) {
        console.error('Error fetching villages:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.delete('/villages/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Check for dependencies (teachers or students)
        // Note: This assumes foreign key constraints will throw an error, 
        // but checking explicitly allows for a better error message.
        const [teachers] = await dbPool.execute('SELECT id FROM teachers WHERE village_id = ?', [id]);
        if (teachers.length > 0) {
            return res.status(409).json({ error: 'Cannot delete village. There are teachers assigned to this village.' });
        }

        const [students] = await dbPool.execute('SELECT id FROM students WHERE village_id = ?', [id]);
        if (students.length > 0) {
            return res.status(409).json({ error: 'Cannot delete village. There are students assigned to this village.' });
        }

        const sql = 'DELETE FROM villages WHERE id = ?';
        const [result] = await dbPool.execute(sql, [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Village not found.' });
        }

        res.status(200).json({ message: 'Village deleted successfully.' });
    } catch (error) {
        console.error('Error deleting village:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// === TEACHER MANAGEMENT ROUTES (FULL CRUD) ===

app.post('/teachers', async (req, res) => {
    try {
        const { name, email, employee_code, password, latitude, longitude, village_id } = req.body;

        if (!name || !email || !employee_code || !password || latitude === undefined || longitude === undefined) {
            return res.status(400).json({ error: 'Missing required fields: name, email, employee_code, password, latitude, and longitude.' });
        }

        const sql = 'INSERT INTO teachers (name, email, employee_code, password, latitude, longitude, village_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const [result] = await dbPool.execute(sql, [name, email, employee_code, password, latitude, longitude, village_id || null]);

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

app.get('/teachers', authenticateAdmin, async (req, res) => {
    try {
        const { village_id } = req.query;
        let sql = `
            SELECT t.id, t.name, t.email, t.employee_code, t.village_id, v.village_name 
            FROM teachers t
            LEFT JOIN villages v ON t.village_id = v.id
        `;

        const params = [];
        if (village_id) {
            sql += ' WHERE t.village_id = ?';
            params.push(village_id);
        }

        sql += ' ORDER BY t.name';

        const [teachers] = await dbPool.execute(sql, params);
        res.status(200).json(teachers);
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/teachers/:id/attendance', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const sql = `
            SELECT check_in_time, check_out_time
            FROM attendance
            WHERE teacher_id = ?
            ORDER BY check_in_time DESC
        `;
        const [attendance] = await dbPool.execute(sql, [id]);
        res.status(200).json(attendance);
    } catch (error) {
        console.error('Error fetching teacher attendance history:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/teachers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const sql = `
            SELECT t.id, t.name, t.email, t.employee_code, t.created_at, t.latitude, t.longitude, t.village_id, v.village_name 
            FROM teachers t 
            LEFT JOIN villages v ON t.village_id = v.id 
            WHERE t.id = ?
        `;
        const [rows] = await dbPool.execute(sql, [id]);
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
        const { name, email, employee_code, latitude, longitude, village_id } = req.body;

        if (!name && !email && !employee_code && latitude === undefined && longitude === undefined && village_id === undefined) {
            return res.status(400).json({ error: 'At least one field must be provided for update.' });
        }

        const fieldsToUpdate = [];
        const values = [];
        if (name) { fieldsToUpdate.push('name = ?'); values.push(name); }
        if (email) { fieldsToUpdate.push('email = ?'); values.push(email); }
        if (employee_code) { fieldsToUpdate.push('employee_code = ?'); values.push(employee_code); }
        if (latitude !== undefined) { fieldsToUpdate.push('latitude = ?'); values.push(latitude); }
        if (longitude !== undefined) { fieldsToUpdate.push('longitude = ?'); values.push(longitude); }
        if (village_id !== undefined) { fieldsToUpdate.push('village_id = ?'); values.push(village_id); }
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

// NEW: Middleware to find today's session and determine action
const getAttendanceAction = async (req, res, next) => {
    try {
        const { teacher_id } = req.body;
        if (!teacher_id) {
            return res.status(400).json({ error: 'teacher_id is missing.' });
        }

        const todayDate = new Date().toISOString().slice(0, 10);
        const checkSql = 'SELECT id, check_in_time, check_out_time FROM attendance WHERE teacher_id = ? AND DATE(check_in_time) = ?';
        const [existing] = await dbPool.execute(checkSql, [teacher_id, todayDate]);

        if (existing.length === 0) {
            req.attendanceAction = 'check_in';
            req.session = null;
        } else {
            const session = existing[0];
            if (session.check_out_time !== null) {
                req.attendanceAction = 'completed';
                req.session = session;
            } else {
                req.attendanceAction = 'check_out';
                req.session = session;
            }
        }
        next();
    } catch (error) {
        console.error('Error in getAttendanceAction middleware:', error);
        res.status(500).json({ error: 'An internal server error occurred while checking attendance status.' });
    }
};

// MODIFIED: /attendance route now handles check-in AND check-out
// FIXED: Swapped middleware order. 'upload' must run before 'getAttendanceAction' to populate req.body.
app.post('/attendance', [upload.fields([{ name: 'photo1', maxCount: 1 }, { name: 'photo2', maxCount: 1 }]), getAttendanceAction], async (req, res) => {

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
        const { attendanceAction, session } = req;

        // --- Basic validation ---
        if (!latitude || !longitude || !photo1 || !photo2) {
            cleanupFiles();
            return res.status(400).json({ error: 'Missing required fields: latitude, longitude, and two photos.' });
        }

        // --- Handle case where session is already completed ---
        if (attendanceAction === 'completed') {
            cleanupFiles();
            return res.status(409).json({ error: 'Attendance session for today is already completed.' });
        }

        // --- Location Validation ---
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
                error: `You are out of the allowed range.`,
                details: `Your distance is ${distance.toFixed(2)}m. Allowed range is ${ALLOWED_RADIUS_METERS}m.`
            });
        }

        const photoPath1 = photo1.path;
        const photoPath2 = photo2.path;

        // --- Execute Check-in or Check-out ---

        if (attendanceAction === 'check_in') {
            // This is a new session (INSERT)
            const sql = `
                INSERT INTO attendance 
                (teacher_id, check_in_time, check_in_photo_url1, check_in_photo_url2, check_in_latitude, check_in_longitude) 
                VALUES (?, NOW(), ?, ?, ?, ?)
            `;
            const [result] = await dbPool.execute(sql, [teacher_id, photoPath1, photoPath2, latitude, longitude]);

            res.status(201).json({
                message: 'Check-in successful!',
                attendanceId: result.insertId,
            });

        } else if (attendanceAction === 'check_out') {
            // This is an existing session (UPDATE)
            const sql = `
                UPDATE attendance 
                SET check_out_time = NOW(), 
                    check_out_photo_url1 = ?, 
                    check_out_photo_url2 = ?, 
                    check_out_latitude = ?, 
                    check_out_longitude = ?
                WHERE id = ?
            `;
            const [result] = await dbPool.execute(sql, [photoPath1, photoPath2, latitude, longitude, session.id]);

            res.status(200).json({
                message: 'Check-out successful!',
                attendanceId: session.id,
            });
        }

    } catch (error) {
        cleanupFiles();
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            return res.status(404).json({ error: `Teacher with ID ${req.body.teacher_id} does not exist.` });
        }
        console.error('Error marking attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// NEW: Endpoint for teacher to check their current status
app.get('/attendance/status/:teacher_id', async (req, res) => {
    try {
        const { teacher_id } = req.params;
        const todayDate = new Date().toISOString().slice(0, 10);

        const sql = 'SELECT id, check_in_time, check_out_time FROM attendance WHERE teacher_id = ? AND DATE(check_in_time) = ?';
        const [rows] = await dbPool.execute(sql, [teacher_id, todayDate]);

        if (rows.length === 0) {
            return res.status(200).json({ status: 'not_checked_in' });
        }

        const session = rows[0];
        if (session.check_out_time === null) {
            return res.status(200).json({
                status: 'checked_in',
                check_in_time: session.check_in_time
            });
        } else {
            return res.status(200).json({
                status: 'completed',
                check_in_time: session.check_in_time,
                check_out_time: session.check_out_time
            });
        }
    } catch (error) {
        console.error('Error fetching attendance status:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


app.get('/attendance/today', async (req, res) => {
    try {
        const todayDate = new Date().toISOString().slice(0, 10);
        const { village_id } = req.query;

        let sql = `
            SELECT 
                a.id as attendance_id, a.teacher_id, t.name as teacher_name, t.employee_code, 
                a.check_in_time, a.check_out_time, 
                a.check_in_photo_url1, a.check_in_photo_url2,
                a.check_out_photo_url1, a.check_out_photo_url2
            FROM attendance a JOIN teachers t ON a.teacher_id = t.id
            WHERE DATE(a.check_in_time) = ? 
        `;

        const params = [todayDate];
        if (village_id) {
            sql += ` AND t.village_id = ?`;
            params.push(village_id);
        }

        sql += ` ORDER BY a.check_in_time DESC`;

        const [records] = await dbPool.execute(sql, params);

        // MODIFIED: Add all photo URLs
        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            check_in_photo_url1: record.check_in_photo_url1 ? `/uploads/${path.basename(record.check_in_photo_url1)}` : null,
            check_in_photo_url2: record.check_in_photo_url2 ? `/uploads/${path.basename(record.check_in_photo_url2)}` : null,
            check_out_photo_url1: record.check_out_photo_url1 ? `/uploads/${path.basename(record.check_out_photo_url1)}` : null,
            check_out_photo_url2: record.check_out_photo_url2 ? `/uploads/${path.basename(record.check_out_photo_url2)}` : null
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
        const { village_id } = req.query;

        let sql = `
            SELECT t.id, t.name, t.employee_code, t.email
            FROM teachers t
            LEFT JOIN attendance a ON t.id = a.teacher_id AND DATE(a.check_in_time) = ?
            WHERE a.id IS NULL
        `;

        const params = [todayDate];
        if (village_id) {
            sql += ` AND t.village_id = ?`;
            params.push(village_id);
        }

        sql += ` ORDER BY t.name`;

        const [absentTeachers] = await dbPool.execute(sql, params);
        res.status(200).json({ count: absentTeachers.length, data: absentTeachers });
    } catch (error) {
        console.error('Error fetching absent teachers:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/report/weekly', async (req, res) => {
    try {
        const sql = `
            SELECT 
                a.id, a.teacher_id, t.name, t.employee_code, 
                a.check_in_time, a.check_out_time, 
                a.check_in_photo_url1, a.check_in_photo_url2,
                a.check_out_photo_url1, a.check_out_photo_url2
            FROM attendance a JOIN teachers t ON a.teacher_id = t.id
            WHERE a.check_in_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            ORDER BY a.check_in_time DESC, t.name
        `;
        const [records] = await dbPool.execute(sql);

        // MODIFIED: Add all photo URLs
        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            check_in_photo_url1: record.check_in_photo_url1 ? `/uploads/${path.basename(record.check_in_photo_url1)}` : null,
            check_in_photo_url2: record.check_in_photo_url2 ? `/uploads/${path.basename(record.check_in_photo_url2)}` : null,
            check_out_photo_url1: record.check_out_photo_url1 ? `/uploads/${path.basename(record.check_out_photo_url1)}` : null,
            check_out_photo_url2: record.check_out_photo_url2 ? `/uploads/${path.basename(record.check_out_photo_url2)}` : null
        }));

        res.status(200).json({ count: records.length, data: recordsWithPhotoUrl });

    } catch (error) {
        console.error('Error fetching weekly attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


app.get('/attendance/report/all', async (req, res) => {
    try {
        const { startDate, endDate, village_id } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Both startDate and endDate query parameters are required (YYYY-MM-DD).' });
        }

        let sql = `
            SELECT 
                a.id, a.teacher_id, t.name, t.employee_code, 
                a.check_in_time, a.check_out_time, 
                a.check_in_photo_url1, a.check_in_photo_url2,
                a.check_out_photo_url1, a.check_out_photo_url2,
                v.village_name
            FROM attendance a 
            JOIN teachers t ON a.teacher_id = t.id
            LEFT JOIN villages v ON t.village_id = v.id
            WHERE DATE(a.check_in_time) BETWEEN ? AND ?
        `;

        const params = [startDate, endDate];

        if (village_id) {
            sql += ' AND t.village_id = ?';
            params.push(village_id);
        }

        sql += ' ORDER BY a.check_in_time DESC, t.name';

        const [records] = await dbPool.execute(sql, params);

        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            check_in_photo_url1: record.check_in_photo_url1 ? `/uploads/${path.basename(record.check_in_photo_url1)}` : null,
            check_in_photo_url2: record.check_in_photo_url2 ? `/uploads/${path.basename(record.check_in_photo_url2)}` : null,
            check_out_photo_url1: record.check_out_photo_url1 ? `/uploads/${path.basename(record.check_out_photo_url1)}` : null,
            check_out_photo_url2: record.check_out_photo_url2 ? `/uploads/${path.basename(record.check_out_photo_url2)}` : null
        }));

        res.status(200).json({ count: records.length, data: recordsWithPhotoUrl });

    } catch (error) {
        console.error('Error fetching attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/report/students', async (req, res) => {
    try {
        const { startDate, endDate, village_id } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Both startDate and endDate query parameters are required (YYYY-MM-DD).' });
        }

        let sql = `
            SELECT 
                sa.id, sa.date, sa.status, 
                s.first_name, s.last_name, s.age,
                v.village_name,
                t.name as marked_by_teacher
            FROM student_attendance sa
            JOIN students s ON sa.student_id = s.id
            LEFT JOIN villages v ON s.village_id = v.id
            LEFT JOIN teachers t ON sa.teacher_id = t.id
            WHERE sa.date BETWEEN ? AND ?
        `;

        const params = [startDate, endDate];

        if (village_id) {
            sql += ' AND s.village_id = ?';
            params.push(village_id);
        }

        sql += ' ORDER BY sa.date DESC, s.first_name';

        const [records] = await dbPool.execute(sql, params);

        res.status(200).json({ count: records.length, data: records });

    } catch (error) {
        console.error('Error fetching student attendance report:', error);
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

        // MODIFIED: Select all new columns
        const sql = `
            SELECT 
                id, 
                check_in_time, check_out_time,
                check_in_photo_url1, check_in_photo_url2, 
                check_out_photo_url1, check_out_photo_url2, 
                check_in_latitude, check_in_longitude,
                check_out_latitude, check_out_longitude
            FROM attendance 
            WHERE teacher_id = ? AND DATE(check_in_time) BETWEEN ? AND ?
            ORDER BY check_in_time DESC
        `;
        const [records] = await dbPool.execute(sql, [teacher_id, startDate, endDate]);

        // MODIFIED: Add all photo URLs
        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            check_in_photo_url1: record.check_in_photo_url1 ? `/uploads/${path.basename(record.check_in_photo_url1)}` : null,
            check_in_photo_url2: record.check_in_photo_url2 ? `/uploads/${path.basename(record.check_in_photo_url2)}` : null,
            check_out_photo_url1: record.check_out_photo_url1 ? `/uploads/${path.basename(record.check_out_photo_url1)}` : null,
            check_out_photo_url2: record.check_out_photo_url2 ? `/uploads/${path.basename(record.check_out_photo_url2)}` : null
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

        // MODIFIED: Select new columns and filter by check_in_time
        let sql = `
            SELECT 
                id, teacher_id, 
                check_in_time, check_out_time,
                check_in_photo_url1, check_in_photo_url2, 
                check_out_photo_url1, check_out_photo_url2, 
                check_in_latitude, check_in_longitude,
                check_out_latitude, check_out_longitude
            FROM attendance 
            WHERE teacher_id = ?
        `;
        const params = [teacher_id];

        if (filter === 'week') {
            sql += ' AND check_in_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
        } else if (filter === 'month') {
            sql += ' AND MONTH(check_in_time) = MONTH(NOW()) AND YEAR(check_in_time) = YEAR(NOW())';
        }

        sql += ' ORDER BY check_in_time DESC';

        const [records] = await dbPool.execute(sql, params);

        if (records.length === 0) {
            return res.status(200).json([]); // Return empty array for consistency
        }

        // MODIFIED: Add all photo URLs
        const recordsWithPhotoUrl = records.map(record => ({
            ...record,
            check_in_photo_url1: record.check_in_photo_url1 ? `/uploads/${path.basename(record.check_in_photo_url1)}` : null,
            check_in_photo_url2: record.check_in_photo_url2 ? `/uploads/${path.basename(record.check_in_photo_url2)}` : null,
            check_out_photo_url1: record.check_out_photo_url1 ? `/uploads/${path.basename(record.check_out_photo_url1)}` : null,
            check_out_photo_url2: record.check_out_photo_url2 ? `/uploads/${path.basename(record.check_out_photo_url2)}` : null
        }));

        res.status(200).json(recordsWithPhotoUrl);

    } catch (error) {
        console.error('Error fetching teacher attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// NEW: Get students for a teacher (based on same village)
app.get('/teacher/:teacher_id/students', async (req, res) => {
    try {
        const { teacher_id } = req.params;

        // 1. Get teacher's village_id
        const [teacherRows] = await dbPool.execute('SELECT village_id FROM teachers WHERE id = ?', [teacher_id]);

        if (teacherRows.length === 0) {
            return res.status(404).json({ error: 'Teacher not found.' });
        }

        const village_id = teacherRows[0].village_id;

        if (!village_id) {
            return res.status(200).json([]); // Teacher has no village assigned, so no students
        }

        // 2. Get students in that village
        const sql = `
            SELECT s.id, s.first_name, s.last_name, s.age, v.village_name
            FROM students s
            JOIN villages v ON s.village_id = v.id
            WHERE s.village_id = ?
            ORDER BY s.first_name, s.last_name
        `;
        const [students] = await dbPool.execute(sql, [village_id]);

        res.status(200).json(students);

    } catch (error) {
        console.error('Error fetching teacher students:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- STUDENT ATTENDANCE ROUTES ---

app.post('/attendance/students', async (req, res) => {
    try {
        const { teacher_id, date, attendanceData } = req.body;
        // attendanceData = [{ student_id: 1, status: 'present' }, ...]

        if (!teacher_id || !date || !Array.isArray(attendanceData)) {
            return res.status(400).json({ error: 'Invalid input data.' });
        }

        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();

            for (const record of attendanceData) {
                const { student_id, status } = record;
                const sql = `
                    INSERT INTO student_attendance (student_id, teacher_id, date, status)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE status = VALUES(status), teacher_id = VALUES(teacher_id)
                `;
                await connection.execute(sql, [student_id, teacher_id, date, status]);
            }

            await connection.commit();
            res.status(200).json({ message: 'Student attendance saved successfully.' });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error saving student attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.get('/attendance/students/:teacher_id/:date', async (req, res) => {
    try {
        const { teacher_id, date } = req.params;

        // First get village_id of teacher
        const [teacherRows] = await dbPool.execute('SELECT village_id FROM teachers WHERE id = ?', [teacher_id]);
        if (teacherRows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
        const village_id = teacherRows[0].village_id;

        if (!village_id) return res.status(200).json([]);

        const sql = `
            SELECT s.id as student_id, sa.status
            FROM students s
            LEFT JOIN student_attendance sa ON s.id = sa.student_id AND sa.date = ?
            WHERE s.village_id = ?
        `;
        const [rows] = await dbPool.execute(sql, [date, village_id]);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching student attendance:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// NEW: Admin Student Attendance Report
app.get('/reports/students', authenticateAdmin, async (req, res) => {
    try {
        const { date, village_id } = req.query;

        let sql = `
            SELECT 
                s.first_name, 
                s.last_name, 
                v.village_name, 
                sa.date, 
                sa.status,
                t.name as teacher_name
            FROM students s
            JOIN villages v ON s.village_id = v.id
            LEFT JOIN student_attendance sa ON s.id = sa.student_id
            LEFT JOIN teachers t ON sa.teacher_id = t.id
            WHERE 1=1
        `;

        const params = [];

        if (date) {
            sql += ' AND sa.date = ?';
            params.push(date);
        }

        if (village_id) {
            sql += ' AND s.village_id = ?';
            params.push(village_id);
        }

        sql += ' AND sa.id IS NOT NULL ORDER BY sa.date DESC, v.village_name, s.first_name';

        const [rows] = await dbPool.execute(sql, params);
        res.status(200).json(rows);

    } catch (error) {
        console.error('Error fetching student attendance report:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// === DASHBOARD ROUTES ===

app.get('/dashboard/stats', async (req, res) => {
    try {
        const todayDate = new Date().toISOString().slice(0, 10);

        const [totalResult] = await dbPool.execute('SELECT COUNT(id) as total_teachers FROM teachers');
        const totalTeachers = totalResult[0].total_teachers;

        // MODIFIED: Check against 'check_in_time'
        const [presentResult] = await dbPool.execute('SELECT COUNT(DISTINCT teacher_id) as present_teachers FROM attendance WHERE DATE(check_in_time) = ?', [todayDate]);
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

// --- function to create villages table ---
const createVillagesTable = async () => {
    const sql = `
        CREATE TABLE IF NOT EXISTS villages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            village_name VARCHAR(255) NOT NULL,
            state VARCHAR(255) NOT NULL,
            pincode VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;
    try {
        await dbPool.execute(sql);
        console.log('Villages table checked/created successfully.');
    } catch (error) {
        console.error('Error creating villages table:', error);
    }
};

// --- function to update teachers table schema ---
const updateTeachersTableSchema = async () => {
    try {
        // Check if village_id column exists
        const [columns] = await dbPool.execute("SHOW COLUMNS FROM teachers LIKE 'village_id'");
        if (columns.length === 0) {
            console.log('Adding village_id column to teachers table...');
            await dbPool.execute("ALTER TABLE teachers ADD COLUMN village_id INT DEFAULT NULL");
            await dbPool.execute("ALTER TABLE teachers ADD CONSTRAINT fk_village FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL");
            console.log('village_id column added successfully.');
        }
    } catch (error) {
        console.error('Error updating teachers table schema:', error);
    }
};

// --- function to create students table ---
const createStudentsTable = async () => {
    const sql = `
        CREATE TABLE IF NOT EXISTS students (
            id INT AUTO_INCREMENT PRIMARY KEY,
            first_name VARCHAR(255) NOT NULL,
            last_name VARCHAR(255) NOT NULL,
            village_id INT,
            age INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL
        )
    `;
    try {
        await dbPool.execute(sql);
        console.log('Students table checked/created successfully.');
    } catch (error) {
        console.error('Error creating students table:', error);
    }
};

// --- function to create student_attendance table ---
const createStudentAttendanceTable = async () => {
    const sql = `
        CREATE TABLE IF NOT EXISTS student_attendance (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id INT NOT NULL,
            teacher_id INT NOT NULL,
            date DATE NOT NULL,
            status ENUM('present', 'absent') NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_student_date (student_id, date),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
        )
    `;
    try {
        await dbPool.execute(sql);
        console.log('Student attendance table checked/created successfully.');
    } catch (error) {
        console.error('Error creating student attendance table:', error);
    }
};

// --- function to check database connection ---
const checkDatabaseConnection = async () => {
    console.log('Checking database connection...');
    try {
        const [rows] = await dbPool.query('SELECT 1 + 1 AS solution');
        console.log(`Database connection successful! Test query result: 2`);
        return true;
    } catch (error) {
        console.error('!!! FAILED TO CONNECT TO DATABASE !!!');
        console.error('Error:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error(`Hint: Is the database server running on "${process.env.DB_HOST}"?`);
        }
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error(`Hint: Check your .env file for correct DB_USER ("${process.env.DB_USER}") and DB_PASSWORD.`);
        }
        if (error.code === 'ER_BAD_DB_ERROR') {
            console.error(`Hint: Does the database "${process.env.DB_NAME}" exist?`);
        }
        return false;
    }
};

// --- Modified server start logic ---
const startServer = async () => {
    const isDbConnected = await checkDatabaseConnection();

    if (isDbConnected) {
        await createVillagesTable();
        await updateTeachersTableSchema();
        await createStudentsTable();
        await createStudentAttendanceTable();
        app.listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
        });
    } else {
        console.error('Server is not starting due to database connection failure.');
        process.exit(1); // Exit the process with an error code
    }
};

// Start the server
startServer();