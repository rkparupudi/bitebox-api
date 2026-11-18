import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Logger,
  Module,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { Public } from '../auth/auth.module';
import { CartModule } from '../cart/cart.module';
import { AuthUser, CurrentUser, Role, Roles } from '../common/roles';
import { PaymentGateway, PaymentsModule } from '../payments/payments.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { OrderStatus } from './order-status';
import { Order, OrderItem, OrderStatusEvent } from './order.entities';
import { OrdersService } from './orders.service';

export class CheckoutDto {
  @IsString() @MinLength(5) @MaxLength(500) deliveryAddress: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
}

export class CancelDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Roles(Role.CUSTOMER)
  @Post('orders')
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto) {
    return this.orders.checkout(user, dto);
  }

  @Roles(Role.CUSTOMER)
  @Get('orders')
  myOrders(
    @CurrentUser() user: AuthUser,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.orders.listForCustomer(user, limit, offset);
  }

  @Get('orders/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findForUser(user, id);
  }

  @Roles(Role.CUSTOMER)
  @Get('orders/:id/payment')
  paymentSecret(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getPaymentSecret(user, id);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Patch('orders/:id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.orders.updateStatus(user, id, dto.status);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.orders.cancel(user, id, dto.reason);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Get('restaurants/:id/orders')
  restaurantOrders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status', new ParseEnumPipe(OrderStatus, { optional: true })) status?: OrderStatus,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return this.orders.listForRestaurant(user, id, status, limit, offset);
  }

  @Roles(Role.RESTAURANT_OWNER, Role.ADMIN)
  @Get('restaurants/:id/sales')
  sales(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 3600 * 1000);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) || fromDate >= toDate) {
      throw new BadRequestException('from and to must be ISO dates with from < to');
    }
    return this.orders.salesReport(user, id, fromDate, toDate);
  }
}

/**
 * Stripe calls this endpoint. It is public (Stripe has no JWT) and is authenticated by
 * verifying the Stripe-Signature header against the raw, unparsed request body.
 */
@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly gateway: PaymentGateway,
    private readonly orders: OrdersService,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    if (!signature || !req.rawBody) throw new BadRequestException('Missing Stripe signature');
    let event;
    try {
      event = this.gateway.constructEvent(req.rawBody, signature);
    } catch (err) {
      this.logger.warn(`Rejected webhook: ${(err as Error).message}`);
      throw new BadRequestException('Invalid Stripe signature');
    }
    const { duplicate } = await this.orders.handleStripeEvent(event);
    return { received: true, duplicate };
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, OrderStatusEvent]),
    RestaurantsModule,
    CartModule,
    PaymentsModule,
  ],
  controllers: [OrdersController, PaymentWebhookController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
