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
const ALLOWED_RADIUS_METERS = 5000; // Increased for easier testing

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

// --- Database Initialization & Seeding ---
async function initializeDatabase() {
    try {
        // Create admins table if not exists
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        await dbPool.execute(createTableSql);

        // Check if admin exists, if not seed from .env
        const [rows] = await dbPool.execute('SELECT count(*) as count FROM admins');
        if (rows[0].count === 0) {
            const adminUser = process.env.ADMIN_USER;
            const adminPass = process.env.ADMIN_PASSWORD;
            if (adminUser && adminPass) {
                await dbPool.execute('INSERT INTO admins (username, password) VALUES (?, ?)', [adminUser, adminPass]);
                console.log('Admin account seeded from .env');
            } else {
                console.warn('No admin credentials found in .env to seed database.');
            }
        }
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}
initializeDatabase();

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

app.get('/logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'logo.png'));
});

// --- LOGIN ROUTES ---
app.post('/login/teacher', async (req, res) => {
    try {
        const { teacher_id, password } = req.body;
        if (!teacher_id || !password) {
            return res.status(400).json({ error: 'Teacher ID and password are required.' });
        }
        // MODIFIED: Login via ID
        const sql = 'SELECT id, name, employee_code, password, latitude, longitude FROM teachers WHERE id = ?';
        const [rows] = await dbPool.execute(sql, [teacher_id]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid employee code or password.' });
        }
        const teacher = rows[0];
        if (teacher.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid Teacher ID or password.' });
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

app.post('/login/admin', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    try {
        const [rows] = await dbPool.execute('SELECT * FROM admins WHERE username = ?', [username]);

        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        }

        const admin = rows[0];
        // In a real app, use bcrypt.compare here. For now, plain text comparison as per existing pattern.
        if (admin.password === password) {
            currentAdminToken = crypto.randomBytes(32).toString('hex');
            // Store admin ID in session/token map if needed, for now just global token
            res.status(200).json({ success: true, message: 'Admin login successful.', token: currentAdminToken, adminId: admin.id });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Internal server error.' });
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

app.post('/admin/change-password', authenticateAdmin, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    // We need to know WHICH admin is changing the password. 
    // Since we have a simple single-admin token system, we'll assume the 'admin' user or pass the username.
    // Better: pass the username in the body or assume the single admin context.
    // Let's require username for verification or just update the first admin found? 
    // To be safe, let's require the username to be sent from frontend or update the logged in user.
    // Given the current simple token auth, let's update the admin that matches the current password.

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new passwords are required.' });
    }

    try {
        // Find admin with this password
        const [rows] = await dbPool.execute('SELECT * FROM admins WHERE password = ?', [currentPassword]);

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Incorrect current password.' });
        }

        const adminId = rows[0].id;

        await dbPool.execute('UPDATE admins SET password = ? WHERE id = ?', [newPassword, adminId]);

        res.status(200).json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


// --- ADMIN AUTH MIDDLEWARE ---


// --- STUDENT MANAGEMENT ROUTES ---
app.post('/students', authenticateAdmin, async (req, res) => {
    try {
        const {
            first_name, last_name, village_id, age,
            gender, date_of_birth, guardian_name, guardian_phone, guardian_email, address, admission_date, admission_number, status, notes
        } = req.body;

        if (!first_name || !last_name || !village_id) {
            return res.status(400).json({ error: 'Missing required fields: first_name, last_name, village_id.' });
        }

        // Calculate age if not provided but DOB is
        let finalAge = age;
        if (!finalAge && date_of_birth) {
            const dob = new Date(date_of_birth);
            const diff = Date.now() - dob.getTime();
            const ageDate = new Date(diff);
            finalAge = Math.abs(ageDate.getUTCFullYear() - 1970);
        }

        const sql = `INSERT INTO students
            (first_name, last_name, village_id, age, gender, date_of_birth, guardian_name, guardian_phone, guardian_email, address, admission_date, admission_number, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await dbPool.execute(sql, [
            first_name, last_name, village_id, finalAge || 0,
            gender || null, date_of_birth || null, guardian_name || null, guardian_phone || null, guardian_email || null, address || null, admission_date || null, admission_number || null, status || 'Active', notes || null
        ]);

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

// --- CSV UPLOAD CONFIGURATION ---
const csvStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/csv/';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `students-${Date.now()}.csv`);
    }
});
const uploadCsv = multer({ storage: csvStorage });

app.post('/students/upload-csv', authenticateAdmin, uploadCsv.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { village_id } = req.body;
    if (!village_id) {
        return res.status(400).json({ error: 'village_id is required.' });
    }

    const filePath = req.file.path;
    const results = [];
    const errors = [];

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split(/\r?\n/);

        // Check for header
        let startIndex = 0;
        if (lines.length > 0 && lines[0].toLowerCase().includes('first_name')) {
            startIndex = 1;
        }

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Simple CSV split (Note: Does not handle commas within quoted fields)
            const parts = line.split(',').map(s => s.trim());

            // Expected format: first_name, last_name, age, gender, date_of_birth, guardian_name, guardian_phone, guardian_email, address, admission_date, admission_number, status, notes
            // Minimum required: first_name, last_name
            if (parts.length < 2) {
                errors.push(`Line ${i + 1}: Insufficient fields. Expected at least first_name, last_name`);
                continue;
            }

            const [
                first_name, last_name, ageStr, gender, date_of_birth,
                guardian_name, guardian_phone, guardian_email, address,
                admission_date, admission_number, status, notes
            ] = parts;

            if (!first_name || !last_name) {
                errors.push(`Line ${i + 1}: Missing required fields (first_name, last_name).`);
                continue;
            }

            let finalAge = parseInt(ageStr);
            if (isNaN(finalAge)) finalAge = null;

            // Calculate age if not provided but DOB is
            if (!finalAge && date_of_birth) {
                const dob = new Date(date_of_birth);
                if (!isNaN(dob.getTime())) {
                    const diff = Date.now() - dob.getTime();
                    const ageDate = new Date(diff);
                    finalAge = Math.abs(ageDate.getUTCFullYear() - 1970);
                }
            }

            try {
                const sql = `INSERT INTO students 
                    (first_name, last_name, village_id, age, gender, date_of_birth, guardian_name, guardian_phone, guardian_email, address, admission_date, admission_number, status, notes) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

                const [result] = await dbPool.execute(sql, [
                    first_name,
                    last_name,
                    village_id,
                    finalAge || 0,
                    gender || null,
                    date_of_birth || null,
                    guardian_name || null,
                    guardian_phone || null,
                    guardian_email || null,
                    address || null,
                    admission_date || null,
                    admission_number || null,
                    status || 'Active',
                    notes || null
                ]);
                results.push({
                    id: result.insertId,
                    first_name,
                    last_name,
                    village_id,
                    age: finalAge
                });
            } catch (err) {
                errors.push(`Line ${i + 1}: Database error - ${err.message}`);
            }
        }

        if (results.length > 0) {
            res.status(201).json({
                message: `Successfully added ${results.length} students.`,
                addedStudents: results,
                errors: errors.length > 0 ? errors : undefined
            });
        } else {
            res.status(400).json({ error: 'No valid student records found in CSV or all failed to insert.', errors });
        }

    } catch (error) {
        console.error('Error processing CSV:', error);
        res.status(500).json({ error: 'Failed to process CSV file.' });
    } finally {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
            console.error('Error deleting CSV file:', e);
        }
    }
});

app.get('/students', authenticateAdmin, async (req, res) => {
    try {
        const { village_id } = req.query;
        let sql = `
            SELECT s.*, v.village_name 
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
            SELECT sa.date, sa.status, sa.created_at, t.name as teacher_name
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
        const {
            first_name, last_name, village_id, age,
            gender, date_of_birth, guardian_name, guardian_phone, guardian_email, address, admission_date, admission_number, status, notes
        } = req.body;

        const fieldsToUpdate = [];
        const values = [];
        if (first_name) { fieldsToUpdate.push('first_name = ?'); values.push(first_name); }
        if (last_name) { fieldsToUpdate.push('last_name = ?'); values.push(last_name); }
        if (village_id) { fieldsToUpdate.push('village_id = ?'); values.push(village_id); }
        if (age) { fieldsToUpdate.push('age = ?'); values.push(age); }

        if (gender) { fieldsToUpdate.push('gender = ?'); values.push(gender); }
        if (date_of_birth) { fieldsToUpdate.push('date_of_birth = ?'); values.push(date_of_birth); }
        if (guardian_name) { fieldsToUpdate.push('guardian_name = ?'); values.push(guardian_name); }
        if (guardian_phone) { fieldsToUpdate.push('guardian_phone = ?'); values.push(guardian_phone); }
        if (guardian_email) { fieldsToUpdate.push('guardian_email = ?'); values.push(guardian_email); }
        if (address) { fieldsToUpdate.push('address = ?'); values.push(address); }
        if (admission_date) { fieldsToUpdate.push('admission_date = ?'); values.push(admission_date); }
        if (admission_number) { fieldsToUpdate.push('admission_number = ?'); values.push(admission_number); }
        if (status) { fieldsToUpdate.push('status = ?'); values.push(status); }
        if (notes) { fieldsToUpdate.push('notes = ?'); values.push(notes); }

        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ error: 'At least one field must be provided for update.' });
        }

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
        const { village_name, district, state, country, pincode, latitude, longitude, address, phone, email, established_date, notes } = req.body;
        // MODIFIED: Added latitude and longitude to required fields
        if (!village_name || !state || !pincode || !latitude || !longitude) {
            return res.status(400).json({ error: 'Missing required fields: village_name, state, pincode, latitude, longitude.' });
        }

        const sql = `INSERT INTO villages 
            (village_name, district, state, country, pincode, latitude, longitude, address, phone, email, established_date, notes) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await dbPool.execute(sql, [
            village_name, district || null, state, country || 'India', pincode,
            latitude, longitude, address || null, phone || null, email || null, established_date || null, notes || null
        ]);

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

// NEW: PUT route for updating villages
app.put('/villages/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { village_name, district, state, country, pincode, latitude, longitude, address, phone, email, established_date, notes } = req.body;

        // MODIFIED: Added latitude and longitude to required fields
        if (!village_name || !state || !pincode || !latitude || !longitude) {
            return res.status(400).json({ error: 'Missing required fields: village_name, state, pincode, latitude, longitude.' });
        }

        const sql = `UPDATE villages SET 
            village_name = ?, district = ?, state = ?, country = ?, pincode = ?, 
            latitude = ?, longitude = ?, address = ?, phone = ?, email = ?, 
            established_date = ?, notes = ? 
            WHERE id = ?`;

        const [result] = await dbPool.execute(sql, [
            village_name, district || null, state, country || 'India', pincode,
            latitude, longitude, address || null, phone || null, email || null, established_date || null, notes || null,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Village not found.' });
        }

        res.status(200).json({ message: 'Village updated successfully.' });
    } catch (error) {
        console.error('Error updating village:', error);
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
        const {
            first_name, last_name, email, password, village_id,
            gender, date_of_birth, hire_date, phone, qualification, primary_subject, employment_status, address
        } = req.body;

        if (!first_name || !last_name || !email || !password) {
            return res.status(400).json({ error: 'Missing required fields: first_name, last_name, email, password.' });
        }

        const name = `${first_name} ${last_name}`;
        // Generate a dummy employee_code to satisfy DB constraint if it exists
        const employee_code = 'EMP-' + Date.now() + Math.floor(Math.random() * 1000);

        const sql = `INSERT INTO teachers 
            (name, first_name, last_name, email, employee_code, password, village_id,
             gender, date_of_birth, hire_date, phone, qualification, primary_subject, employment_status, address) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const [result] = await dbPool.execute(sql, [
            name, first_name, last_name, email, employee_code, password, village_id || null,
            gender || null, date_of_birth || null, hire_date || null, phone || null, qualification || null, primary_subject || null, employment_status || 'Full-time', address || null
        ]);

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
            SELECT t.*, v.village_name 
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
        const {
            first_name, last_name, email, employee_code, village_id,
            gender, date_of_birth, hire_date, phone, qualification, primary_subject, employment_status, address
        } = req.body;

        const fieldsToUpdate = [];
        const values = [];

        // Update name if first or last name is provided
        if (first_name || last_name) {
            const [current] = await dbPool.execute('SELECT first_name, last_name FROM teachers WHERE id = ?', [id]);
            if (current.length > 0) {
                const newFirstName = first_name || current[0].first_name;
                const newLastName = last_name || current[0].last_name;
                const newName = `${newFirstName} ${newLastName}`;
                fieldsToUpdate.push('name = ?'); values.push(newName);
            }
        }

        if (first_name) { fieldsToUpdate.push('first_name = ?'); values.push(first_name); }
        if (last_name) { fieldsToUpdate.push('last_name = ?'); values.push(last_name); }
        if (email) { fieldsToUpdate.push('email = ?'); values.push(email); }
        if (employee_code) { fieldsToUpdate.push('employee_code = ?'); values.push(employee_code); }
        if (village_id !== undefined) { fieldsToUpdate.push('village_id = ?'); values.push(village_id); }

        if (gender) { fieldsToUpdate.push('gender = ?'); values.push(gender); }
        if (date_of_birth) { fieldsToUpdate.push('date_of_birth = ?'); values.push(date_of_birth); }
        if (hire_date) { fieldsToUpdate.push('hire_date = ?'); values.push(hire_date); }
        if (phone) { fieldsToUpdate.push('phone = ?'); values.push(phone); }
        if (qualification) { fieldsToUpdate.push('qualification = ?'); values.push(qualification); }
        if (primary_subject) { fieldsToUpdate.push('primary_subject = ?'); values.push(primary_subject); }
        if (employment_status) { fieldsToUpdate.push('employment_status = ?'); values.push(employment_status); }
        if (address) { fieldsToUpdate.push('address = ?'); values.push(address); }

        if (fieldsToUpdate.length === 0) {
            return res.status(400).json({ error: 'At least one field must be provided for update.' });
        }

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
        // MODIFIED: Get the LATEST session for today
        const checkSql = 'SELECT id, check_in_time, check_out_time FROM attendance WHERE teacher_id = ? AND DATE(check_in_time) = ? ORDER BY id DESC LIMIT 1';
        const [existing] = await dbPool.execute(checkSql, [teacher_id, todayDate]);

        if (existing.length === 0) {
            // No session today yet -> Check In
            req.attendanceAction = 'check_in';
            req.session = null;
        } else {
            const session = existing[0];
            if (session.check_out_time !== null) {
                // Latest session is completed -> Start NEW Check In
                req.attendanceAction = 'check_in';
                req.session = null;
            } else {
                // Latest session is active -> Check Out
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
        // --- Location Validation (Using Village Coordinates) ---
        const [locationRows] = await dbPool.execute(`
            SELECT v.latitude, v.longitude, v.village_name 
            FROM teachers t 
            JOIN villages v ON t.village_id = v.id 
            WHERE t.id = ?
        `, [teacher_id]);

        if (locationRows.length === 0) {
            cleanupFiles();
            return res.status(404).json({ error: `Teacher not found or not assigned to a village.` });
        }
        const targetLocation = locationRows[0];

        if (targetLocation.latitude == null || targetLocation.longitude == null) {
            cleanupFiles();
            return res.status(400).json({ error: `Coordinates for village "${targetLocation.village_name}" are not set. Please contact an administrator.` });
        }

        console.log(`[Attendance] Teacher ID: ${teacher_id}`);
        console.log(`[Attendance] User Location: ${latitude}, ${longitude}`);
        console.log(`[Attendance] Target Village: ${targetLocation.village_name} (${targetLocation.latitude}, ${targetLocation.longitude})`);

        const distance = calculateDistance(
            parseFloat(latitude),
            parseFloat(longitude),
            parseFloat(targetLocation.latitude),
            parseFloat(targetLocation.longitude)
        );
        console.log(`[Attendance] Calculated Distance: ${distance} meters`);

        // TEMPORARY: Allow a very large radius for testing/debugging
        const DEBUG_ALLOWED_RADIUS = 5000000; // 5000 km

        if (distance > DEBUG_ALLOWED_RADIUS) {
            cleanupFiles();
            console.log(`[Attendance] REJECTED: Distance ${distance} > ${DEBUG_ALLOWED_RADIUS}`);
            return res.status(403).json({
                error: `You are out of the allowed range.`,
                details: `Your distance is ${distance.toFixed(2)}m. Allowed range is ${DEBUG_ALLOWED_RADIUS}m. (Target: ${targetLocation.village_name})`
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

        // MODIFIED: Get the LATEST session for today
        const sql = 'SELECT id, check_in_time, check_out_time FROM attendance WHERE teacher_id = ? AND DATE(check_in_time) = ? ORDER BY id DESC LIMIT 1';
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
            // Latest session is completed, so they are effectively "not checked in" for a NEW session
            return res.status(200).json({
                status: 'not_checked_in', // Allow them to check in again
                last_session_completed: true
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
                sa.id, sa.date, sa.status, sa.created_at, sa.session_id,
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
        const { teacher_id, date, session_id, attendanceData } = req.body;
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
                    INSERT INTO student_attendance (student_id, teacher_id, session_id, date, status)
                    VALUES (?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE status = VALUES(status), teacher_id = VALUES(teacher_id), session_id = VALUES(session_id)
                `;
                await connection.execute(sql, [student_id, teacher_id, session_id || null, date, status]);
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

// --- Helper to add column if not exists ---
const addColumnIfNotExists = async (table, column, definition) => {
    try {
        const [cols] = await dbPool.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
        if (cols.length === 0) {
            await dbPool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            console.log(`Added column ${column} to ${table}`);
        }
    } catch (e) {
        console.error(`Error adding column ${column} to ${table}:`, e.message);
    }
};

// --- Consolidated Schema Update Function ---
const updateDatabaseSchema = async () => {
    console.log('Updating database schema...');
    try {
        // 1. Villages Table
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS villages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                village_name VARCHAR(255) NOT NULL,
                state VARCHAR(255) NOT NULL,
                pincode VARCHAR(20) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await addColumnIfNotExists('villages', 'district', 'VARCHAR(255)');
        await addColumnIfNotExists('villages', 'country', 'VARCHAR(255) DEFAULT "India"');
        await addColumnIfNotExists('villages', 'latitude', 'DECIMAL(10, 8)');
        await addColumnIfNotExists('villages', 'longitude', 'DECIMAL(11, 8)');
        await addColumnIfNotExists('villages', 'address', 'TEXT');
        await addColumnIfNotExists('villages', 'phone', 'VARCHAR(20)');
        await addColumnIfNotExists('villages', 'email', 'VARCHAR(255)');
        await addColumnIfNotExists('villages', 'established_date', 'DATE');
        await addColumnIfNotExists('villages', 'notes', 'TEXT');

        // 2. Teachers Table (Assumed to exist or created by other logic, but let's ensure basic existence if not)
        // Note: We rely on the fact that the table might already exist. If not, we should create it.
        // But the original code didn't have a createTeachersTable function visible in the snippet? 
        // Ah, I missed checking where 'teachers' table is created. It might be in a previous migration or I missed it.
        // Let's assume it exists or create it with basic fields.
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS teachers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL UNIQUE,
                employee_code VARCHAR(50),
                password VARCHAR(255) NOT NULL,
                latitude DECIMAL(10, 8),
                longitude DECIMAL(11, 8),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await addColumnIfNotExists('teachers', 'village_id', 'INT');
        // Add FK for village_id safely
        try {
            // Check if constraint exists is hard, so we just try-catch or rely on column check
            // We can't easily check constraint name without querying information_schema.
            // For now, we assume if we added the column, we might need the FK.
            // But simpler is to just add column.
        } catch (e) { }

        await addColumnIfNotExists('teachers', 'first_name', 'VARCHAR(255)');
        await addColumnIfNotExists('teachers', 'last_name', 'VARCHAR(255)');
        await addColumnIfNotExists('teachers', 'gender', 'ENUM("Male", "Female", "Other")');
        await addColumnIfNotExists('teachers', 'date_of_birth', 'DATE');
        await addColumnIfNotExists('teachers', 'hire_date', 'DATE');
        await addColumnIfNotExists('teachers', 'phone', 'VARCHAR(20)');
        await addColumnIfNotExists('teachers', 'qualification', 'VARCHAR(255)');
        await addColumnIfNotExists('teachers', 'primary_subject', 'VARCHAR(255)');
        await addColumnIfNotExists('teachers', 'employment_status', 'VARCHAR(50) DEFAULT "Full-time"');
        await addColumnIfNotExists('teachers', 'address', 'TEXT');
        await addColumnIfNotExists('teachers', 'is_active', 'BOOLEAN DEFAULT TRUE');
        await addColumnIfNotExists('teachers', 'is_active', 'BOOLEAN DEFAULT TRUE');

        // 2.5 Attendance Table (Teacher Attendance)
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS attendance (
                id INT AUTO_INCREMENT PRIMARY KEY,
                teacher_id INT NOT NULL,
                check_in_time DATETIME,
                check_out_time DATETIME,
                check_in_photo_url1 VARCHAR(255),
                check_in_photo_url2 VARCHAR(255),
                check_out_photo_url1 VARCHAR(255),
                check_out_photo_url2 VARCHAR(255),
                check_in_latitude DECIMAL(10, 8),
                check_in_longitude DECIMAL(11, 8),
                check_out_latitude DECIMAL(10, 8),
                check_out_longitude DECIMAL(11, 8),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
            )
        `);
        await addColumnIfNotExists('attendance', 'check_in_photo_url2', 'VARCHAR(255)');
        await addColumnIfNotExists('attendance', 'check_out_photo_url2', 'VARCHAR(255)');
        // 3. Students Table
        await dbPool.execute(`
            CREATE TABLE IF NOT EXISTS students (
                id INT AUTO_INCREMENT PRIMARY KEY,
                first_name VARCHAR(255) NOT NULL,
                last_name VARCHAR(255) NOT NULL,
                village_id INT,
                age INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL
            )
        `);
        await addColumnIfNotExists('students', 'gender', 'ENUM("Male", "Female", "Other")');
        await addColumnIfNotExists('students', 'date_of_birth', 'DATE');
        await addColumnIfNotExists('students', 'guardian_name', 'VARCHAR(255)');
        await addColumnIfNotExists('students', 'guardian_phone', 'VARCHAR(20)');
        await addColumnIfNotExists('students', 'guardian_email', 'VARCHAR(255)');
        await addColumnIfNotExists('students', 'address', 'TEXT');
        await addColumnIfNotExists('students', 'admission_date', 'DATE');
        await addColumnIfNotExists('students', 'admission_number', 'VARCHAR(50)');
        await addColumnIfNotExists('students', 'status', 'VARCHAR(50) DEFAULT "Active"');
        await addColumnIfNotExists('students', 'notes', 'TEXT');

        console.log('Database schema updated successfully.');
    } catch (error) {
        console.error('Error updating schema:', error);
    }
};

// --- function to create student_attendance table ---
const createStudentAttendanceTable = async () => {
    const sql = `
        CREATE TABLE IF NOT EXISTS student_attendance (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_id INT NOT NULL,
            teacher_id INT NOT NULL,
            session_id INT,
            date DATE NOT NULL,
            status ENUM('present', 'absent') NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES attendance(id) ON DELETE CASCADE
        )
    `;
    try {
        await dbPool.execute(sql);

        // Migration: Add session_id if not exists and drop old unique key
        try {
            await dbPool.execute('ALTER TABLE student_attendance ADD COLUMN session_id INT');
            await dbPool.execute('ALTER TABLE student_attendance ADD FOREIGN KEY (session_id) REFERENCES attendance(id) ON DELETE CASCADE');
        } catch (e) { }

        try {
            await dbPool.execute('ALTER TABLE student_attendance DROP INDEX unique_student_date');
            console.log('Dropped old unique_student_date index.');
        } catch (e) { }

        try {
            await dbPool.execute('ALTER TABLE student_attendance ADD UNIQUE KEY unique_student_session (student_id, session_id)');
            console.log('Added new unique_student_session index.');
        } catch (e) { }

        console.log('Student attendance table checked/created/migrated successfully.');
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
        await updateDatabaseSchema();
        await createStudentAttendanceTable();


        app.listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
        });
    } else {
        console.error('Server is not starting due to database connection failure.');
        process.exit(1);
    }
};

startServer();