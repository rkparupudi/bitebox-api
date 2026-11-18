import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Module,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { IsBoolean } from 'class-validator';
import { Repository } from 'typeorm';
import { Role, Roles } from '../common/roles';
import { OrderStatus } from '../orders/order-status';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { Restaurant } from '../restaurants/restaurant.entities';
import { RestaurantsModule, RestaurantsService } from '../restaurants/restaurants.module';

export class SetActiveDto {
  @IsBoolean() isActive: boolean;
}

/** Platform administration: every route here is admin-only. */
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly orders: OrdersService,
    private readonly restaurantsService: RestaurantsService,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
  ) {}

  @Get('orders')
  listOrders(
    @Query('status', new ParseEnumPipe(OrderStatus, { optional: true })) status?: OrderStatus,
    @Query('restaurantId', new ParseUUIDPipe({ optional: true })) restaurantId?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return this.orders.listAll(status, restaurantId, limit, offset);
  }

  @Get('restaurants')
  listRestaurants() {
    return this.restaurants.find({ order: { createdAt: 'DESC' }, relations: { owner: true } });
  }

  /** Suspend or reinstate a restaurant. Suspended restaurants disappear from search and can't take orders. */
  @Patch('restaurants/:id/active')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetActiveDto) {
    return this.restaurantsService.setActive(id, dto.isActive);
  }
}

@Module({
  imports: [OrdersModule, RestaurantsModule, TypeOrmModule.forFeature([Restaurant])],
  controllers: [AdminController],
})
export class AdminModule {}
