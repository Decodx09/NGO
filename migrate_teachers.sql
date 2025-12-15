-- Add missing columns to the teachers table
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS village_id INT;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS gender ENUM('Male', 'Female', 'Other');
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS hire_date DATE;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS qualification VARCHAR(255);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS primary_subject VARCHAR(255);
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS employment_status VARCHAR(50) DEFAULT 'Full-time';
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- Add Foreign Key for village_id if it doesn't exist (this might fail if it exists, which is fine)
SET @dbname = DATABASE();
SET @tablename = "teachers";
SET @columnname = "village_id";
SET @constraintname = "fk_teachers_village";

SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = @dbname
    AND TABLE_NAME = @tablename
    AND CONSTRAINT_NAME = @constraintname
  ) > 0,
  "SELECT 1",
  "ALTER TABLE teachers ADD CONSTRAINT fk_teachers_village FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE SET NULL;"
));

PREPARE stmt FROM @preparedStatement;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
