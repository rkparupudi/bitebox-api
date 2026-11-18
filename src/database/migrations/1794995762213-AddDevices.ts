import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDevices1794995762213 implements MigrationInterface {
    name = 'AddDevices1794995762213'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "token" character varying NOT NULL, "platform" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e8a5d59f0ac3040395f159507c" ON "devices" ("userId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_653b03d2083d8c66240b8df066" ON "devices" ("token") `);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "FK_e8a5d59f0ac3040395f159507c6" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "devices" DROP CONSTRAINT "FK_e8a5d59f0ac3040395f159507c6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_653b03d2083d8c66240b8df066"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e8a5d59f0ac3040395f159507c"`);
        await queryRunner.query(`DROP TABLE "devices"`);
    }

}
