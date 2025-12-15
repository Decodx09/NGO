DELIMITER //

DROP PROCEDURE IF EXISTS AddCol //

CREATE PROCEDURE AddCol(
    IN tbl VARCHAR(255),
    IN col VARCHAR(255),
    IN def VARCHAR(255)
)
BEGIN
    DECLARE continue_handler INT DEFAULT 0;
    SELECT COUNT(*) INTO continue_handler
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
    AND table_name = tbl
    AND column_name = col;
    
    IF continue_handler = 0 THEN
        SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', def);
        PREPARE stmt FROM @s;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END //

DELIMITER ;

CALL AddCol('teachers', 'village_id', 'INT');
CALL AddCol('teachers', 'first_name', 'VARCHAR(255)');
CALL AddCol('teachers', 'last_name', 'VARCHAR(255)');
CALL AddCol('teachers', 'gender', 'ENUM("Male", "Female", "Other")');
CALL AddCol('teachers', 'date_of_birth', 'DATE');
CALL AddCol('teachers', 'hire_date', 'DATE');
CALL AddCol('teachers', 'phone', 'VARCHAR(20)');
CALL AddCol('teachers', 'qualification', 'VARCHAR(255)');
CALL AddCol('teachers', 'primary_subject', 'VARCHAR(255)');
CALL AddCol('teachers', 'employment_status', 'VARCHAR(50) DEFAULT "Full-time"');
CALL AddCol('teachers', 'address', 'TEXT');
CALL AddCol('teachers', 'is_active', 'BOOLEAN DEFAULT TRUE');

DROP PROCEDURE AddCol;

-- Add Foreign Key safely (ignoring error if exists)
SET @dbname = DATABASE();
SET @tablename = "teachers";
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
