-- Standard SQL for older MySQL versions
-- Run these one by one. If a column exists, it will error, which is safe to ignore.

ALTER TABLE teachers ADD COLUMN village_id INT;
ALTER TABLE teachers ADD COLUMN first_name VARCHAR(255);
ALTER TABLE teachers ADD COLUMN last_name VARCHAR(255);
ALTER TABLE teachers ADD COLUMN gender ENUM('Male', 'Female', 'Other');
ALTER TABLE teachers ADD COLUMN date_of_birth DATE;
ALTER TABLE teachers ADD COLUMN hire_date DATE;
ALTER TABLE teachers ADD COLUMN phone VARCHAR(20);
ALTER TABLE teachers ADD COLUMN qualification VARCHAR(255);
ALTER TABLE teachers ADD COLUMN primary_subject VARCHAR(255);
ALTER TABLE teachers ADD COLUMN employment_status VARCHAR(50) DEFAULT 'Full-time';
ALTER TABLE teachers ADD COLUMN address TEXT;
ALTER TABLE teachers ADD COLUMN is_active BOOLEAN DEFAULT TRUE;

-- Add Foreign Key (Wrap in a procedure to avoid error if exists, or just run it and ignore error)
ALTER TABLE teachers ADD CONSTRAINT fk_teachers_village FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL;
