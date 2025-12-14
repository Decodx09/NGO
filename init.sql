-- 1. Villages Table
CREATE TABLE IF NOT EXISTS villages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    village_name VARCHAR(255) NOT NULL,
    state VARCHAR(255) NOT NULL,
    pincode VARCHAR(20) NOT NULL,
    district VARCHAR(255),
    country VARCHAR(255) DEFAULT "India",
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    address TEXT,
    phone VARCHAR(20),
    email VARCHAR(255),
    established_date DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Teachers Table
CREATE TABLE IF NOT EXISTS teachers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    employee_code VARCHAR(50),
    password VARCHAR(255) NOT NULL,
    village_id INT,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    gender ENUM("Male", "Female", "Other"),
    date_of_birth DATE,
    hire_date DATE,
    phone VARCHAR(20),
    qualification VARCHAR(255),
    primary_subject VARCHAR(255),
    employment_status VARCHAR(50) DEFAULT "Full-time",
    address TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL
);

-- 3. Attendance Table (Teacher Attendance)
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
);

-- 4. Students Table
CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    village_id INT,
    age INT,
    gender ENUM("Male", "Female", "Other"),
    date_of_birth DATE,
    guardian_name VARCHAR(255),
    guardian_phone VARCHAR(20),
    guardian_email VARCHAR(255),
    address TEXT,
    admission_date DATE,
    admission_number VARCHAR(50),
    status VARCHAR(50) DEFAULT "Active",
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL
);

-- 5. Student Attendance Table
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
    FOREIGN KEY (session_id) REFERENCES attendance(id) ON DELETE CASCADE,
    UNIQUE KEY unique_student_session (student_id, session_id)
);
