-- Existing Tables (for reference)
-- attendance (teacher_id, check_in_time, ...)
-- student_attendance (student_id, teacher_id, date, status)
-- students (first_name, last_name, village_id, age)
-- teachers (name, email, employee_code, ...)
-- villages (village_name, state, pincode)

-- PROPOSED NEW TABLES

-- 1. Schools (If there are multiple schools, otherwise we might not need this if it's a single school system, but 'villages' implies distributed locations)
CREATE TABLE IF NOT EXISTS schools (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    village_id INT,
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (village_id) REFERENCES villages(id)
);

-- 2. Academic Terms (e.g., Term 1 2025, Term 2 2025)
CREATE TABLE IF NOT EXISTS terms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL, -- e.g., "Fall 2025"
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_current BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Classes (e.g., Grade 1, Grade 2, or Class 1A, Class 1B)
CREATE TABLE IF NOT EXISTS classes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL, -- e.g., "Grade 5"
    grade_level INT NOT NULL,
    school_id INT, -- Optional if multi-school
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (school_id) REFERENCES schools(id)
);

-- 4. Subjects (e.g., Math, Science)
CREATE TABLE IF NOT EXISTS subjects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20), -- e.g., "MTH101"
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Class Subjects (Which subjects are taught in which class)
CREATE TABLE IF NOT EXISTS class_subjects (
    class_id INT NOT NULL,
    subject_id INT NOT NULL,
    PRIMARY KEY (class_id, subject_id),
    FOREIGN KEY (class_id) REFERENCES classes(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

-- 6. Teacher Subjects (Which teacher teaches which subject, potentially linked to a class)
CREATE TABLE IF NOT EXISTS teacher_subjects (
    teacher_id INT NOT NULL,
    subject_id INT NOT NULL,
    class_id INT, -- Optional: if a teacher teaches a subject specifically for a class
    PRIMARY KEY (teacher_id, subject_id, class_id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (class_id) REFERENCES classes(id)
);

-- 7. Enrollments (Linking students to classes for an academic year)
CREATE TABLE IF NOT EXISTS enrollments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    class_id INT NOT NULL,
    academic_year VARCHAR(20) NOT NULL, -- e.g., "2025-2026"
    enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (class_id) REFERENCES classes(id)
);

-- 8. Exams
CREATE TABLE IF NOT EXISTS exams (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL, -- e.g., "Mid-Term Math"
    term_id INT,
    class_id INT NOT NULL,
    subject_id INT NOT NULL,
    date DATE NOT NULL,
    total_marks INT DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (term_id) REFERENCES terms(id),
    FOREIGN KEY (class_id) REFERENCES classes(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

-- 9. Exam Results
CREATE TABLE IF NOT EXISTS exam_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    student_id INT NOT NULL,
    marks_obtained DECIMAL(5,2),
    grade VARCHAR(5), -- e.g., "A", "B"
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (exam_id) REFERENCES exams(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
);

-- 10. Class Sessions (For more granular attendance tracking than just daily)
CREATE TABLE IF NOT EXISTS class_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    class_id INT NOT NULL,
    subject_id INT,
    teacher_id INT NOT NULL,
    date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    topic VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (class_id) REFERENCES classes(id),
    FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (teacher_id) REFERENCES teachers(id)
);

-- Update student_attendance to link to class_sessions? 
-- Or keep it simple. The current student_attendance is (student_id, teacher_id, date, status).
-- We might want to add class_id to it.

ALTER TABLE student_attendance ADD COLUMN class_id INT;
-- ALTER TABLE student_attendance ADD CONSTRAINT fk_sa_class FOREIGN KEY (class_id) REFERENCES classes(id);
