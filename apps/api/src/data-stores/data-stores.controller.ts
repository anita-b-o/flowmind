import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { OrganizationRole } from "@automation/shared-types";
import { CurrentUser, type CurrentUser as CurrentUserType } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrganizationContext } from "../organizations/organization-context.decorator";
import { OrganizationGuard } from "../organizations/organization.guard";
import { Roles } from "../rbac/roles.decorator";
import { RolesGuard } from "../rbac/roles.guard";
import { DataStoresService } from "./data-stores.service";
import { CreateDataStoreDto, ListDataStoreRecordsQueryDto, UpdateDataStoreDto, UpsertDataStoreRecordDto } from "./dto/data-store.dto";

@ApiTags("data-stores")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrganizationGuard, RolesGuard)
@Roles(OrganizationRole.Editor)
@Controller("data-stores")
export class DataStoresController {
  constructor(private readonly dataStores: DataStoresService) {}

  @Get()
  list(@OrganizationContext() org: OrganizationContext) {
    return this.dataStores.list(org.organizationId);
  }

  @Post()
  create(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Body() dto: CreateDataStoreDto) {
    return this.dataStores.create(org.organizationId, user.userId, dto);
  }

  @Get(":dataStoreId")
  detail(@OrganizationContext() org: OrganizationContext, @Param("dataStoreId") dataStoreId: string) {
    return this.dataStores.detail(org.organizationId, dataStoreId);
  }

  @Patch(":dataStoreId")
  update(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("dataStoreId") dataStoreId: string, @Body() dto: UpdateDataStoreDto) {
    return this.dataStores.update(org.organizationId, user.userId, dataStoreId, dto);
  }

  @Delete(":dataStoreId")
  delete(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("dataStoreId") dataStoreId: string) {
    return this.dataStores.delete(org.organizationId, user.userId, dataStoreId);
  }

  @Get(":dataStoreId/records")
  listRecords(@OrganizationContext() org: OrganizationContext, @Param("dataStoreId") dataStoreId: string, @Query() query: ListDataStoreRecordsQueryDto) {
    return this.dataStores.listRecords(org.organizationId, dataStoreId, query);
  }

  @Get(":dataStoreId/records/:key")
  getRecord(@OrganizationContext() org: OrganizationContext, @Param("dataStoreId") dataStoreId: string, @Param("key") key: string) {
    return this.dataStores.getRecord(org.organizationId, dataStoreId, key);
  }

  @Delete(":dataStoreId/records/:key")
  deleteRecord(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("dataStoreId") dataStoreId: string, @Param("key") key: string) {
    return this.dataStores.deleteRecord(org.organizationId, user.userId, dataStoreId, key);
  }

  @Put(":dataStoreId/records/:key")
  upsertRecord(@OrganizationContext() org: OrganizationContext, @CurrentUser() user: CurrentUserType, @Param("dataStoreId") dataStoreId: string, @Param("key") key: string, @Body() dto: UpsertDataStoreRecordDto) {
    return this.dataStores.upsertRecord(org.organizationId, user.userId, dataStoreId, key, dto);
  }
}
