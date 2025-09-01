-- Add working_time column to attendance_records table with correct PostgreSQL type
ALTER TABLE "attendance_records" ADD COLUMN "working_time" INTEGER;
