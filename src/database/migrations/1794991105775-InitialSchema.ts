import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1794991105775 implements MigrationInterface {
    name = 'InitialSchema1794991105775'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('customer', 'restaurant_owner', 'admin')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "fullName" character varying NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'customer', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "restaurants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ownerId" uuid NOT NULL, "name" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "address" character varying NOT NULL, "latitude" double precision, "longitude" double precision, "isOpen" boolean NOT NULL DEFAULT false, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e2133a72eb1cc8f588f7b503e68" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9519e81d388514ec631d23fefc" ON "restaurants" ("ownerId") `);
        await queryRunner.query(`CREATE TABLE "menu_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "restaurantId" uuid NOT NULL, "name" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "category" character varying NOT NULL DEFAULT 'Mains', "priceMinor" integer NOT NULL, "isAvailable" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_57e6188f929e5dc6919168620c8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a8ff5699334d3ca7b07421af0a" ON "menu_items" ("restaurantId") `);
        await queryRunner.query(`CREATE TYPE "public"."orders_status_enum" AS ENUM('pending_payment', 'placed', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customerId" uuid NOT NULL, "restaurantId" uuid NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending_payment', "subtotalMinor" integer NOT NULL, "deliveryFeeMinor" integer NOT NULL, "totalMinor" integer NOT NULL, "currency" character varying(3) NOT NULL, "deliveryAddress" character varying NOT NULL, "notes" text, "cancelReason" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8311c4d0fbd4353ed30b9cd69d" ON "orders" ("customerId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_83255440210b4491d3b67dfdd7" ON "orders" ("restaurantId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "menuItemId" uuid, "name" character varying NOT NULL, "unitPriceMinor" integer NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f1d359a55923bb45b057fbdab0" ON "order_items" ("orderId") `);
        await queryRunner.query(`CREATE TYPE "public"."order_status_events_fromstatus_enum" AS ENUM('pending_payment', 'placed', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'cancelled')`);
        await queryRunner.query(`CREATE TYPE "public"."order_status_events_tostatus_enum" AS ENUM('pending_payment', 'placed', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "order_status_events" ("id" SERIAL NOT NULL, "orderId" uuid NOT NULL, "fromStatus" "public"."order_status_events_fromstatus_enum", "toStatus" "public"."order_status_events_tostatus_enum" NOT NULL, "actor" character varying NOT NULL, "actorUserId" uuid, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cee8187701a1f5ca1d3780f89dc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_44ab379565419185f6292ae3ac" ON "order_status_events" ("orderId") `);
        await queryRunner.query(`CREATE TYPE "public"."payments_status_enum" AS ENUM('requires_payment', 'succeeded', 'failed', 'canceled', 'refunded')`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "provider" character varying NOT NULL DEFAULT 'stripe', "providerPaymentId" character varying NOT NULL, "amountMinor" integer NOT NULL, "currency" character varying(3) NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'requires_payment', "lastError" text, "refundId" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_af929a5f2a400fdb6913b4967e" ON "payments" ("orderId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50d2f08323fc3531369f2f4184" ON "payments" ("providerPaymentId") `);
        await queryRunner.query(`CREATE TABLE "processed_webhook_events" ("eventId" character varying NOT NULL, "type" character varying NOT NULL, "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_368ec518fc75788b7910ead7c7c" PRIMARY KEY ("eventId"))`);
        await queryRunner.query(`ALTER TABLE "restaurants" ADD CONSTRAINT "FK_9519e81d388514ec631d23fefca" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD CONSTRAINT "FK_a8ff5699334d3ca7b07421af0a9" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_d8453d5a71e525d9b406c35aab8" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_status_events" ADD CONSTRAINT "FK_44ab379565419185f6292ae3ac6" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_status_events" DROP CONSTRAINT "FK_44ab379565419185f6292ae3ac6"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_d8453d5a71e525d9b406c35aab8"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_e5de51ca888d8b1f5ac25799dd1"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP CONSTRAINT "FK_a8ff5699334d3ca7b07421af0a9"`);
        await queryRunner.query(`ALTER TABLE "restaurants" DROP CONSTRAINT "FK_9519e81d388514ec631d23fefca"`);
        await queryRunner.query(`DROP TABLE "processed_webhook_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_50d2f08323fc3531369f2f4184"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_af929a5f2a400fdb6913b4967e"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44ab379565419185f6292ae3ac"`);
        await queryRunner.query(`DROP TABLE "order_status_events"`);
        await queryRunner.query(`DROP TYPE "public"."order_status_events_tostatus_enum"`);
        await queryRunner.query(`DROP TYPE "public"."order_status_events_fromstatus_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f1d359a55923bb45b057fbdab0"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_83255440210b4491d3b67dfdd7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8311c4d0fbd4353ed30b9cd69d"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a8ff5699334d3ca7b07421af0a"`);
        await queryRunner.query(`DROP TABLE "menu_items"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9519e81d388514ec631d23fefc"`);
        await queryRunner.query(`DROP TABLE "restaurants"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    }

}
