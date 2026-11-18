import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import Redis from 'ioredis';
import { ILike, Repository } from 'typeorm';
import { Public } from '../auth/auth.module';
import { REDIS } from '../common/redis.module';
import { AuthUser, CurrentUser, Role, Roles } from '../common/roles';
import { MenuItem, Restaurant } from './restaurant.entities';

// ---------- DTOs ----------

export class CreateRestaurantDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsString() @MinLength(1) address: string;
  @IsOptional() @IsLatitude() latitude?: number;
  @IsOptional() @IsLongitude() longitude?: number;
}

export class UpdateRestaurantDto extends PartialType(CreateRestaurantDto) {
  @IsOptional() @IsBoolean() isOpen?: boolean;
}

export class CreateMenuItemDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsInt() @Min(1) @Max(10_000_000) priceMinor: number;
  @IsOptional() @IsBoolean() isAvailable?: boolean;
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {}

// ---------- service ----------

const MENU_TTL_SECONDS = 300;
const menuKey = (restaurantId: string) => `menu:${restaurantId}`;

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  listPublic(q?: string) {
    return this.restaurants.find({
      where: { isActive: true, ...(q ? { name: ILike(`%${q}%`) } : {}) },
      order: { isOpen: 'DESC', name: 'ASC' },
      take: 100,
    });
  }

  listMine(user: AuthUser) {
    return this.restaurants.find({ where: { ownerId: user.id }, order: { createdAt: 'ASC' } });
  }

  create(user: AuthUser, dto: CreateRestaurantDto) {
    return this.restaurants.save(this.restaurants.create({ ...dto, ownerId: user.id }));
  }

  async update(user: AuthUser, id: string, dto: UpdateRestaurantDto) {
    const restaurant = await this.getOwned(user, id);
    Object.assign(restaurant, dto);
    const saved = await this.restaurants.save(restaurant);
    await this.invalidateMenu(id);
    return saved;
  }

  /**
   * Public menu, cache-aside in Redis: read the cache, fall back to Postgres on a miss,
   * write the result back with a TTL. Every write to the restaurant or its items deletes the key.
   */
  async getMenu(restaurantId: string) {
    const cached = await this.redis.get(menuKey(restaurantId));
    if (cached) return JSON.parse(cached);

    const restaurant = await this.restaurants.findOne({ where: { id: restaurantId, isActive: true } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    const items = await this.items.find({
      where: { restaurantId, isAvailable: true },
      order: { category: 'ASC', name: 'ASC' },
    });
    const menu = { restaurant, items };
    await this.redis.set(menuKey(restaurantId), JSON.stringify(menu), 'EX', MENU_TTL_SECONDS);
    return menu;
  }

  /** Owner's view: includes unavailable items, never cached. */
  async getMenuForOwner(user: AuthUser, restaurantId: string) {
    await this.getOwned(user, restaurantId);
    return this.items.find({ where: { restaurantId }, order: { category: 'ASC', name: 'ASC' } });
  }

  async addItem(user: AuthUser, restaurantId: string, dto: CreateMenuItemDto) {
    await this.getOwned(user, restaurantId);
    const item = await this.items.save(this.items.create({ ...dto, restaurantId }));
    await this.invalidateMenu(restaurantId);
    return item;
  }

  async updateItem(user: AuthUser, restaurantId: string, itemId: string, dto: UpdateMenuItemDto) {
    await this.getOwned(user, restaurantId);
    const item = await this.items.findOne({ where: { id: itemId, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    Object.assign(item, dto);
    const saved = await this.items.save(item);
    await this.invalidateMenu(restaurantId);
    return saved;
  }

  async removeItem(user: AuthUser, restaurantId: string, itemId: string) {
    await this.getOwned(user, restaurantId);
    const result = await this.items.delete({ id: itemId, restaurantId });
    if (!result.affected) throw new NotFoundException('Menu item not found');
    await this.invalidateMenu(restaurantId);
  }

  async setActive(id: string, isActive: boolean) {
    const restaurant = await this.restaurants.findOne({ where: { id } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    restaurant.isActive = isActive;
    const saved = await this.restaurants.save(restaurant);
    await this.invalidateMenu(id);
    return saved;
  }

  /** Loads a restaurant and checks the caller owns it. Admins can act on any restaurant. */
  async getOwned(user: AuthUser, id: string) {
    const restaurant = await this.restaurants.findOne({ where: { id } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (user.role !== Role.ADMIN && restaurant.ownerId !== user.id) {
      throw new ForbiddenException('You do not manage this restaurant');
    }
    return restaurant;
  }

  private invalidateMenu(restaurantId: string) {
    return this.redis.del(menuKey(restaurantId));
  }
}

// ---------- controller ----------

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly service: RestaurantsService) {}

  @Public()
  @Get()
  list(@Query('q') q?: string) {
    return this.service.listPublic(q);
  }

  // Declared before ':id' routes so "mine" isn't parsed as an id.
  @Roles(Role.RESTAURANT_OWNER)
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.service.listMine(user);
  }

  @Public()
  @Get(':id/menu')
  menu(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getMenu(id);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Get(':id/menu-items')
  ownerMenu(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getMenuForOwner(user, id);
  }

  @Roles(Role.RESTAURANT_OWNER)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRestaurantDto) {
    return this.service.create(user, dto);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Post(':id/menu-items')
  addItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.service.addItem(user, id, dto);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Patch(':id/menu-items/:itemId')
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.service.updateItem(user, id, itemId, dto);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Delete(':id/menu-items/:itemId')
  @HttpCode(204)
  removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.removeItem(user, id, itemId);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Restaurant, MenuItem])],
  controllers: [RestaurantsController],
  providers: [RestaurantsService],
  exports: [RestaurantsService, TypeOrmModule],
})
export class RestaurantsModule {}
