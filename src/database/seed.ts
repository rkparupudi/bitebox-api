/**
 * Seeds demo data: one admin, one restaurant owner with a restaurant and menu, one customer.
 * Run after migrations:  npm run seed
 * All passwords are "password123". For local development only.
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { Role } from '../common/roles';
import { MenuItem, Restaurant } from '../restaurants/restaurant.entities';
import { User } from '../users/user.entity';
import { dataSourceOptions } from './data-source';

async function main() {
  const ds = await new DataSource(dataSourceOptions()).initialize();
  await ds.runMigrations(); // so a fresh database works: create tables, then seed
  const users = ds.getRepository(User);
  const hash = await bcrypt.hash('password123', 12);

  const upsertUser = async (email: string, fullName: string, role: Role) =>
    (await users.findOneBy({ email })) ?? users.save(users.create({ email, fullName, role, passwordHash: hash }));

  await upsertUser('admin@bitebridge.dev', 'Platform Admin', Role.ADMIN);
  const owner = await upsertUser('owner@bitebridge.dev', 'Ravi Owner', Role.RESTAURANT_OWNER);
  await upsertUser('customer@bitebridge.dev', 'Asha Customer', Role.CUSTOMER);

  const restaurants = ds.getRepository(Restaurant);
  if (!(await restaurants.findOneBy({ ownerId: owner.id }))) {
    const r = await restaurants.save(
      restaurants.create({
        ownerId: owner.id,
        name: 'Whitefield Biryani House',
        description: 'Dum biryani and kebabs',
        address: 'ITPL Main Road, Whitefield, Bengaluru',
        latitude: 12.9855,
        longitude: 77.7310,
        isOpen: true,
      }),
    );
    const items = ds.getRepository(MenuItem);
    await items.save([
      { restaurantId: r.id, name: 'Chicken Dum Biryani', category: 'Biryani', priceMinor: 32000 },
      { restaurantId: r.id, name: 'Paneer Biryani', category: 'Biryani', priceMinor: 28000 },
      { restaurantId: r.id, name: 'Chicken Seekh Kebab', category: 'Starters', priceMinor: 24000 },
      { restaurantId: r.id, name: 'Raita', category: 'Sides', priceMinor: 6000 },
      { restaurantId: r.id, name: 'Double Ka Meetha', category: 'Desserts', priceMinor: 12000 },
    ].map((i) => items.create(i)));
  }
  console.log('Seeded. Logins (password123): admin@, owner@, customer@bitebridge.dev');
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
