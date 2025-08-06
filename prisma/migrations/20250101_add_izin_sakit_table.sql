-- CreateTable
CREATE TABLE "izin_sakit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "tanggal" DATE NOT NULL,
    "jenis" VARCHAR(20) NOT NULL,
    "alasan" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "izin_sakit_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "izin_sakit" ADD CONSTRAINT "izin_sakit_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE; 