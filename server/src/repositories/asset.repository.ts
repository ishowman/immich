import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { isEmpty, isUndefined, omitBy } from 'lodash';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/db';
import { Chunked, ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AssetJobStatusEntity } from 'src/entities/asset-job-status.entity';
import { AssetEntity } from 'src/entities/asset.entity';
import { ExifEntity } from 'src/entities/exif.entity';
import { AssetFileType, AssetType } from 'src/enum';
import {
  AssetCreate,
  AssetDeltaSyncOptions,
  AssetExploreFieldOptions,
  AssetFullSyncOptions,
  AssetGetByChecksumOptions,
  AssetPathEntity,
  AssetStats,
  AssetStatsOptions,
  AssetUpdateAllOptions,
  AssetUpdateDuplicateOptions,
  AssetUpdateOptions,
  DayOfYearAssets,
  DuplicateGroup,
  GetByIdsRelations,
  IAssetRepository,
  LivePhotoSearchOptions,
  MonthDay,
  TimeBucketItem,
  TimeBucketOptions,
  TimeBucketSize,
  WithProperty,
  WithoutProperty,
} from 'src/interfaces/asset.interface';
import { MapMarker, MapMarkerSearchOptions } from 'src/interfaces/map.interface';
import { AssetSearchOptions, SearchExploreItem, SearchExploreItemSet } from 'src/interfaces/search.interface';
import {
  UPSERT_COLUMNS,
  anyUuid,
  asUuid,
  getUpsertColumns,
  hasPeople,
  hasPeopleCte,
  mapUpsertColumns,
  searchAssetBuilder,
  withAlbums,
  withExif,
  withFaces,
  withFacesAndPeople,
  withFiles,
  withLibrary,
  withOwner,
  withSmartSearch,
  withStack,
} from 'src/utils/database';
import { Instrumentation } from 'src/utils/instrumentation';
import { Paginated, PaginationOptions, paginationHelper } from 'src/utils/pagination';

@Instrumentation()
@Injectable()
export class AssetRepository implements IAssetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async upsertExif(exif: Partial<ExifEntity> & { assetId: string }): Promise<void> {
    const columns = UPSERT_COLUMNS['exif'] ?? (await getUpsertColumns('exif', 'assetId', this.db));
    (exif as any)['assetId'] = asUuid(exif.assetId);

    await this.db
      .insertInto('exif')
      .values(exif as Partial<ExifEntity> & { assetId: string; fileSizeInByte?: string })
      .onConflict((oc) => oc.columns(['assetId']).doUpdateSet(() => mapUpsertColumns(columns!, exif, 'assetId')))
      .execute();
  }

  async upsertJobStatus(...jobStatus: (Partial<AssetJobStatusEntity> & { assetId: string })[]): Promise<void> {
    if (jobStatus.length === 0) {
      return;
    }

    const columns =
      UPSERT_COLUMNS['asset_job_status'] ?? (await getUpsertColumns('asset_job_status', 'assetId', this.db));

    for (const status of jobStatus) {
      (status as any)['assetId'] = asUuid(status.assetId);
    }

    await this.db
      .insertInto('asset_job_status')
      .values(jobStatus)
      .onConflict((oc) =>
        oc.columns(['assetId']).doUpdateSet(() => mapUpsertColumns(columns!, jobStatus[0], 'assetId')),
      )
      .execute();
  }

  create(asset: AssetCreate): Promise<AssetEntity> {
    return this.db.insertInto('assets').values(asset).returningAll().executeTakeFirst() as any as Promise<AssetEntity>;
  }

  @GenerateSql({ params: [DummyValue.UUID, { day: 1, month: 1 }] })
  getByDayOfYear(ownerIds: string[], { day, month }: MonthDay): Promise<DayOfYearAssets[]> {
    // TODO: CREATE INDEX idx_local_date_time ON public.assets ((("localDateTime" AT TIME ZONE 'UTC')::date));
    // TODO: drop IDX_day_of_month and IDX_month
    return this.db
      .with('res', (qb) =>
        qb
          .with('today', (qb) =>
            qb
              .selectFrom((eb) =>
                eb.fn('generate_series', [eb.val(1970), sql`EXTRACT(year FROM current_date) - 1`]).as('year'),
              )
              .select((eb) => eb.fn('make_date', [sql`year::int`, sql`${month}::int`, sql`${day}::int`]).as('date')),
          )
          .selectFrom('today')
          .innerJoinLateral(
            (qb) =>
              qb
                .selectFrom('assets')
                .selectAll('assets')
                .innerJoin('asset_job_status', 'assets.id', 'asset_job_status.assetId')
                .where('asset_job_status.previewAt', 'is not', null)
                .where(sql`(assets."localDateTime" AT TIME ZONE 'UTC')::date`, '=', sql`today.date`)
                .where('assets.ownerId', '=', anyUuid(ownerIds))
                .where('assets.isVisible', '=', true)
                .where('assets.isArchived', '=', false)
                .where((eb) =>
                  eb.exists((qb) =>
                    qb
                      .selectFrom('asset_files')
                      .whereRef('assetId', '=', 'assets.id')
                      .where('asset_files.type', '=', AssetFileType.PREVIEW),
                  ),
                )
                .where('assets.deletedAt', 'is', null)
                .limit(50)
                .as('a'),
            (join) => join.onTrue(),
          )
          .innerJoin('exif', 'a.id', 'exif.assetId')
          .selectAll('a')
          .select((eb) => eb.fn('jsonb_strip_nulls', [eb.fn('to_jsonb', [eb.table('exif')])]).as('exifInfo')),
      )
      .selectFrom('res')
      .select(
        sql<number>`((now() AT TIME ZONE 'UTC')::date - ("localDateTime" AT TIME ZONE 'UTC')::date) / 365`.as(
          'yearsAgo',
        ),
      )
      .select((eb) => eb.fn('jsonb_agg', [eb.table('res')]).as('assets'))
      .groupBy(sql<string>`("localDateTime" AT TIME ZONE 'UTC')::date`)
      .orderBy(sql<string>`("localDateTime" AT TIME ZONE 'UTC')::date`, 'desc')
      .limit(10)
      .execute() as any as Promise<DayOfYearAssets[]>;
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getByIds(
    ids: string[],
    { exifInfo, faces, library, owner, smartSearch, stack, files }: GetByIdsRelations = {},
  ): Promise<AssetEntity[]> {
    const res = await this.db
      .selectFrom('assets')
      .selectAll('assets')
      .where('assets.id', '=', anyUuid(ids))
      .$if(!!exifInfo, (qb) => withExif(qb))
      .$if(!!faces, (qb) => qb.select((eb) => (faces?.person ? withFacesAndPeople(eb) : withFaces(eb))))
      .$if(!!library, (qb) => qb.select((eb) => withLibrary(eb)))
      .$if(!!owner, (qb) => qb.select((eb) => withOwner(eb)))
      .$if(!!smartSearch, (qb) => withSmartSearch(qb))
      .$if(!!stack, (qb) => withStack(qb, { assets: !!stack!.assets, withDeleted: true }))
      .$if(!!files, (qb) => qb.select((eb) => withFiles(eb)))
      // .$if(!!tags, (qb) => qb.select((eb) => withTags(eb))) # TODO: implement tags
      .execute();

    return res as any as AssetEntity[];
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getByIdsWithAllRelations(ids: string[]): Promise<AssetEntity[]> {
    let query = this.db
      .selectFrom('assets')
      .selectAll('assets')
      .select((eb) => withFacesAndPeople(eb))
      .where('assets.id', '=', anyUuid(ids));
    query = withExif(query);
    query = withStack(query, { assets: true, withDeleted: true });
    return query.execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(ownerId: string): Promise<void> {
    await this.db.deleteFrom('assets').where('ownerId', '=', ownerId).execute();
  }

  async getByAlbumId(pagination: PaginationOptions, albumId: string): Paginated<AssetEntity> {
    const items = await withAlbums(this.db.selectFrom('assets'), { albumId })
      .selectAll('assets')
      .where('deletedAt', 'is', null)
      .orderBy('fileCreatedAt', 'desc')
      .execute();

    return paginationHelper(items as any as AssetEntity[], pagination.take);
  }

  async getByDeviceIds(ownerId: string, deviceId: string, deviceAssetIds: string[]): Promise<string[]> {
    const assets = await this.db
      .selectFrom('assets')
      .select(['deviceAssetId'])
      .where('deviceAssetId', 'in', deviceAssetIds)
      .where('deviceId', '=', deviceId)
      .where('ownerId', '=', asUuid(ownerId))
      .execute();

    return assets.map((asset) => asset.deviceAssetId);
  }

  getByUserId(
    pagination: PaginationOptions,
    userId: string,
    options: Omit<AssetSearchOptions, 'userIds'> = {},
  ): Paginated<AssetEntity> {
    return this.getAll(pagination, { ...options, userIds: [userId] });
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getExternalLibraryAssetPaths(pagination: PaginationOptions, libraryId: string): Paginated<AssetPathEntity> {
    const items = await this.db
      .selectFrom('assets')
      .selectAll('assets')
      .where('libraryId', '=', asUuid(libraryId))
      .where('isExternal', '=', true)
      .where('deletedAt', 'is', null)
      .orderBy('fileCreatedAt', 'desc')
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0)
      .execute();

    return paginationHelper(items as any as AssetPathEntity[], pagination.take);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByLibraryIdAndOriginalPath(libraryId: string, originalPath: string): Promise<AssetEntity | undefined> {
    return this.db
      .selectFrom('assets')
      .selectAll('assets')
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', '=', originalPath)
      .limit(1)
      .executeTakeFirst() as any as Promise<AssetEntity | undefined>;
  }

  async getAll(
    pagination: PaginationOptions,
    { orderDirection, ...options }: AssetSearchOptions = {},
  ): Paginated<AssetEntity> {
    const builder = searchAssetBuilder(this.db, options)
      .select((eb) => withFiles(eb))
      .orderBy('assets.createdAt', orderDirection ?? 'asc')
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0);
    const items = await builder.execute();
    return paginationHelper(items as any as AssetEntity[], pagination.take);
  }

  /**
   * Get assets by device's Id on the database
   * @param ownerId
   * @param deviceId
   *
   * @returns Promise<string[]> - Array of assetIds belong to the device
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async getAllByDeviceId(ownerId: string, deviceId: string): Promise<string[]> {
    const items = await this.db
      .selectFrom('assets')
      .select(['deviceAssetId'])
      .where('ownerId', '=', asUuid(ownerId))
      .where('deviceId', '=', deviceId)
      .where('isVisible', '=', true)
      .where('deletedAt', 'is', null)
      .execute();

    return items.map((asset) => asset.deviceAssetId);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLivePhotoCount(motionId: string): Promise<number> {
    const [{ count }] = await this.db
      .selectFrom('assets')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('livePhotoVideoId', '=', asUuid(motionId))
      .execute();
    return count as number;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(
    id: string,
    { exifInfo, faces, library, owner, smartSearch, stack, files }: GetByIdsRelations = {},
  ): Promise<AssetEntity | undefined> {
    return (
      this.db
        .selectFrom('assets')
        .selectAll('assets')
        .where('assets.id', '=', asUuid(id))
        .$if(!!exifInfo, (qb) => withExif(qb))
        .$if(!!faces, (qb) => qb.select((eb) => (faces?.person ? withFacesAndPeople(eb) : withFaces(eb))))
        .$if(!!library, (qb) => qb.select((eb) => withLibrary(eb)))
        .$if(!!owner, (qb) => qb.select((eb) => withOwner(eb)))
        .$if(!!smartSearch, (qb) => withSmartSearch(qb))
        .$if(!!stack, (qb) => withStack(qb, { assets: !!stack!.assets, withDeleted: true }))
        .$if(!!files, (qb) => qb.select((eb) => withFiles(eb)))
        // .$if(!!tags, (qb) => qb.select((eb) => withTags(eb))) # TODO: implement tags
        .executeTakeFirst() as any as Promise<AssetEntity | undefined>
    );
  }

  @GenerateSql({ params: [[DummyValue.UUID], { deviceId: DummyValue.STRING }] })
  @Chunked()
  async updateAll(ids: string[], options: AssetUpdateAllOptions): Promise<void> {
    await this.db.updateTable('assets').set(options).where('id', '=', anyUuid(ids)).execute();
  }

  @GenerateSql({
    params: [{ targetDuplicateId: DummyValue.UUID, duplicateIds: [DummyValue.UUID], assetIds: [DummyValue.UUID] }],
  })
  async updateDuplicates(options: AssetUpdateDuplicateOptions): Promise<void> {
    await this.db
      .updateTable('assets')
      .set({ duplicateId: options.targetDuplicateId })
      .where((eb) =>
        eb.or([eb('duplicateId', '=', anyUuid(options.duplicateIds)), eb('id', '=', anyUuid(options.assetIds))]),
      )
      .execute();
  }

  @Chunked()
  async softDeleteAll(ids: string[]): Promise<void> {
    await this.db.updateTable('assets').set({ deletedAt: new Date() }).where('id', '=', anyUuid(ids)).execute();
  }

  @Chunked()
  async restoreAll(ids: string[]): Promise<void> {
    await this.db.updateTable('assets').set({ deletedAt: null }).where('id', '=', anyUuid(ids)).execute();
  }

  async update({ id, ...asset }: AssetUpdateOptions): Promise<AssetEntity> {
    asset = omitBy(asset, isUndefined);
    if (!isEmpty(asset)) {
      await this.db.updateTable('assets').set(asset).where('id', '=', asUuid(id)).execute();
    }
    // await this.db
    //   .with('assets', (qb) => qb.updateTable('assets').set(asset).where('id', '=', asUuid(id)).returningAll())
    //   .selectFrom('assets')
    //   .$if(true, (qb) => withExif(qb))
    //   .$if(true, (qb) => qb.select((eb) => withFacesAndPeople(eb)))
    //   .executeTakeFirst();

    return this.getById(id, { exifInfo: true, faces: { person: true } }) as Promise<AssetEntity>;
  }

  async remove(asset: AssetEntity): Promise<void> {
    await this.db.deleteFrom('assets').where('id', '=', asUuid(asset.id)).execute();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, checksum: DummyValue.BUFFER }] })
  getByChecksum({ ownerId, libraryId, checksum }: AssetGetByChecksumOptions): Promise<AssetEntity | undefined> {
    return this.db
      .selectFrom('assets')
      .selectAll('assets')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .$if(!libraryId, (qb) => qb.where('libraryId', 'is', null))
      .$if(!!libraryId, (qb) => qb.where('libraryId', '=', asUuid(libraryId!)))
      .limit(1)
      .executeTakeFirst() as Promise<AssetEntity | undefined>;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  getByChecksums(userId: string, checksums: Buffer[]): Promise<AssetEntity[]> {
    return this.db
      .selectFrom('assets')
      .select(['id', 'checksum', 'deletedAt'])
      .where('ownerId', '=', asUuid(userId))
      .where('checksum', 'in', checksums)
      .execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.BUFFER] })
  async getUploadAssetIdByChecksum(ownerId: string, checksum: Buffer): Promise<string | undefined> {
    const asset = await this.db
      .selectFrom('assets')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('checksum', '=', checksum)
      .where('libraryId', 'is', null)
      .limit(1)
      .executeTakeFirst();

    return asset?.id;
  }

  findLivePhotoMatch(options: LivePhotoSearchOptions): Promise<AssetEntity | undefined> {
    const { ownerId, otherAssetId, livePhotoCID, type } = options;

    return this.db
      .selectFrom('assets')
      .innerJoin('exif', 'assets.id', 'exif.assetId')
      .where('id', '!=', asUuid(otherAssetId))
      .where('ownerId', '=', asUuid(ownerId))
      .where('type', '=', type)
      .where('exif.livePhotoCID', '=', livePhotoCID)
      .limit(1)
      .executeTakeFirst() as Promise<AssetEntity | undefined>;
  }

  @GenerateSql(
    ...Object.values(WithProperty)
      .filter((property) => property !== WithProperty.IS_OFFLINE && property !== WithProperty.IS_ONLINE)
      .map((property) => ({
        name: property,
        params: [DummyValue.PAGINATION, property],
      })),
  )
  async getWithout(pagination: PaginationOptions, property: WithoutProperty): Paginated<AssetEntity> {
    const items = await this.db
      .selectFrom('assets')
      .selectAll('assets')
      .$if(property === WithoutProperty.DUPLICATE, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'assets.id', 'job_status.assetId')
          .where('job_status.duplicatesDetectedAt', 'is', null)
          .where('job_status.previewAt', 'is not', null)
          .where((eb) => eb.exists(eb.selectFrom('smart_search').where('assetId', '=', eb.ref('assets.id'))))
          .where('assets.isVisible', '=', true),
      )
      .$if(property === WithoutProperty.ENCODED_VIDEO, (qb) =>
        qb
          .where('assets.type', '=', AssetType.VIDEO)
          .where((eb) => eb.or([eb('assets.encodedVideoPath', 'is', null), eb('assets.encodedVideoPath', '=', '')])),
      )
      .$if(property === WithoutProperty.EXIF, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'assets.id', 'job_status.assetId')
          .where('job_status.metadataExtractedAt', 'is', null)
          .where('assets.isVisible', '=', true),
      )
      .$if(property === WithoutProperty.FACES, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'assetId', 'assets.id')
          .where('job_status.previewAt', 'is not', null)
          .where('job_status.facesRecognizedAt', 'is', null)
          .where('assets.isVisible', '=', true),
      )
      .$if(property === WithoutProperty.PERSON, (qb) =>
        qb
          .where('assets.isVisible', '=', true)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('asset_faces')
                .whereRef('asset_faces.assetId', '=', 'assets.id')
                .where('asset_faces.personId', 'is', null),
            ),
          ),
      )
      .$if(property === WithoutProperty.SIDECAR, (qb) =>
        qb
          .where((eb) => eb.or([eb('assets.sidecarPath', '=', ''), eb('assets.sidecarPath', 'is', null)]))
          .where('assets.isVisible', '=', true),
      )
      .$if(property === WithoutProperty.SMART_SEARCH, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'assetId', 'assets.id')
          .where('job_status.previewAt', 'is not', null)
          .where('assets.isVisible', '=', true)
          .where((eb) =>
            eb.not((eb) => eb.exists(eb.selectFrom('smart_search').whereRef('assetId', '=', 'assets.id'))),
          ),
      )
      .$if(property === WithoutProperty.THUMBNAIL, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'assetId', 'assets.id')
          .select((eb) => withFiles(eb))
          .where('assets.isVisible', '=', true)
          .where((eb) =>
            eb.or([
              eb('job_status.previewAt', 'is', null),
              eb('job_status.thumbnailAt', 'is', null),
              eb('assets.thumbhash', 'is', null),
            ]),
          ),
      )
      .where('deletedAt', 'is', null)
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0)
      .orderBy('createdAt', 'asc')
      .execute();

    return paginationHelper(items as any as AssetEntity[], pagination.take);
  }
  async getWith(
    pagination: PaginationOptions,
    property: WithProperty,
    libraryId?: string,
    withDeleted = false,
  ): Paginated<AssetEntity> {
    const items = await this.db
      .selectFrom('assets')
      .selectAll('assets')
      .$if(property === WithProperty.SIDECAR, (qb) =>
        qb.where('assets.sidecarPath', 'is not', null).where('assets.isVisible', '=', true),
      )
      .$if(property === WithProperty.IS_OFFLINE, (qb) => {
        if (!libraryId) {
          throw new Error('Library id is required when finding offline assets');
        }
        return qb.where('assets.isOffline', '=', true).where('assets.libraryId', '=', asUuid(libraryId));
      })
      .$if(!withDeleted, (qb) => qb.where('deletedAt', 'is', null))
      .limit(pagination.take + 1)
      .offset(pagination.skip ?? 0)
      .orderBy('createdAt', 'asc')
      .execute();

    return paginationHelper(items as any as AssetEntity[], pagination.take);
  }

  getFirstAssetForAlbumId(albumId: string): Promise<AssetEntity | undefined> {
    return this.db
      .selectFrom('assets')
      .innerJoin('albums_assets_assets', 'assets.id', 'albums_assets_assets.assetsId')
      .where('albums_assets_assets.albumsId', '=', asUuid(albumId))
      .orderBy('fileCreatedAt', 'desc')
      .limit(1)
      .executeTakeFirst() as Promise<AssetEntity | undefined>;
  }

  getLastUpdatedAssetForAlbumId(albumId: string): Promise<AssetEntity | undefined> {
    return this.db
      .selectFrom('assets')
      .innerJoin('albums_assets_assets', 'assets.id', 'albums_assets_assets.assetsId')
      .where('albums_assets_assets.albumsId', '=', asUuid(albumId))
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .executeTakeFirst() as Promise<AssetEntity | undefined>;
  }

  getMapMarkers(ownerIds: string[], options: MapMarkerSearchOptions = {}): Promise<MapMarker[]> {
    const { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore } = options;

    return this.db
      .selectFrom('assets')
      .leftJoin('exif', 'assets.id', 'exif.assetId')
      .select(['id', 'latitude as lat', 'longitude as lon', 'city', 'state', 'country'])
      .where('ownerId', '=', anyUuid(ownerIds))
      .where('latitude', 'is not', null)
      .where('longitude', 'is not', null)
      .where('isVisible', '=', true)
      .where('deletedAt', 'is', null)
      .$if(!!isArchived, (qb) => qb.where('isArchived', '=', isArchived!))
      .$if(!!isFavorite, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .$if(!!fileCreatedAfter, (qb) => qb.where('fileCreatedAt', '>=', fileCreatedAfter!))
      .$if(!!fileCreatedBefore, (qb) => qb.where('fileCreatedAt', '<=', fileCreatedBefore!))
      .orderBy('fileCreatedAt', 'desc')
      .execute() as Promise<MapMarker[]>;
  }

  getStatistics(ownerId: string, { isArchived, isFavorite, isTrashed }: AssetStatsOptions): Promise<AssetStats> {
    return this.db
      .selectFrom('assets')
      .select((eb) => eb.fn.countAll().filterWhere('type', '=', AssetType.AUDIO).as(AssetType.AUDIO))
      .select((eb) => eb.fn.countAll().filterWhere('type', '=', AssetType.IMAGE).as(AssetType.IMAGE))
      .select((eb) => eb.fn.countAll().filterWhere('type', '=', AssetType.VIDEO).as(AssetType.VIDEO))
      .select((eb) => eb.fn.countAll().filterWhere('type', '=', AssetType.OTHER).as(AssetType.OTHER))
      .where('ownerId', '=', asUuid(ownerId))
      .where('isVisible', '=', true)
      .$if(isArchived !== undefined, (qb) => qb.where('isArchived', '=', isArchived!))
      .$if(isFavorite !== undefined, (qb) => qb.where('isFavorite', '=', isFavorite!))
      .where('deletedAt', isTrashed ? 'is not' : 'is', null)
      .executeTakeFirst() as Promise<AssetStats>;
  }

  getRandom(userIds: string[], take: number): Promise<AssetEntity[]> {
    const query = this.db.selectFrom('assets').selectAll('assets');
    return withExif(query)
      .where('ownerId', '=', anyUuid(userIds))
      .where('isVisible', '=', true)
      .where('deletedAt', 'is', null)
      .orderBy((eb) => eb.fn('random'))
      .limit(take)
      .execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [{ size: TimeBucketSize.MONTH }] })
  async getTimeBuckets(options: TimeBucketOptions): Promise<TimeBucketItem[]> {
    return ((options.personId ? hasPeopleCte(this.db, [options.personId]) : this.db) as Kysely<DB>)
      .with('assets', (qb) =>
        qb
          .selectFrom('assets')
          .select((eb) =>
            eb.fn<Date>('date_trunc', [eb.val(options.size), sql`"localDateTime" AT TIME ZONE 'UTC'`]).as('timeBucket'),
          )
          .where('assets.deletedAt', options.isTrashed ? 'is not' : 'is', null)
          .where('assets.isVisible', '=', true)
          .$if(!!options.albumId, (qb) =>
            qb
              .innerJoin('albums_assets_assets', 'assets.id', 'albums_assets_assets.assetsId')
              .where('albums_assets_assets.albumsId', '=', asUuid(options.albumId!)),
          )
          .$if(!!options.personId, (qb) =>
            qb.innerJoin(sql.table('has_people').as('has_people'), (join) =>
              join.onRef(sql`has_people."assetId"`, '=', 'assets.id'),
            ),
          )
          .$if(!!options.withStacked, (qb) =>
            qb
              .leftJoin('asset_stack', (join) =>
                join
                  .onRef('asset_stack.id', '=', 'assets.stackId')
                  .onRef('asset_stack.primaryAssetId', '=', 'assets.id'),
              )
              .where((eb) => eb.or([eb('assets.stackId', 'is', null), eb(eb.table('asset_stack'), 'is not', null)])),
          )
          .$if(!!options.userIds, (qb) => qb.where('assets.ownerId', '=', anyUuid(options.userIds!)))
          .$if(!!options.isArchived, (qb) => qb.where('assets.isArchived', '=', options.isArchived!))
          .$if(!!options.isFavorite, (qb) => qb.where('assets.isFavorite', '=', options.isFavorite!))
          .$if(!!options.assetType, (qb) => qb.where('assets.type', '=', options.assetType!))
          .$if(!!options.isDuplicate, (qb) =>
            qb.where('assets.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
          ),
      )
      .selectFrom('assets')
      .select(sql<string>`"timeBucket"::date::text`.as('timeBucket'))
      .select((eb) => eb.fn.countAll().as('count'))
      .groupBy('timeBucket')
      .orderBy('timeBucket', 'desc')
      .execute() as any as Promise<TimeBucketItem[]>;
  }

  @GenerateSql({ params: [DummyValue.TIME_BUCKET, { size: TimeBucketSize.MONTH }] })
  async getTimeBucket(timeBucket: string, options: TimeBucketOptions): Promise<AssetEntity[]> {
    // TODO: CREATE INDEX idx_local_date_time_month ON public.assets (date_trunc('MONTH', "localDateTime" AT TIME ZONE 'UTC'));
    const query = hasPeople(this.db, options.personId ? [options.personId] : undefined).selectAll('assets');
    return withExif(query)
      .$if(!!options.albumId, (qb) => withAlbums(qb, { albumId: options.albumId }))
      .$if(!!options.userIds, (qb) => qb.where('assets.ownerId', '=', anyUuid(options.userIds!)))
      .$if(options.isArchived !== undefined, (qb) => qb.where('assets.isArchived', '=', options.isArchived!))
      .$if(options.isFavorite !== undefined, (qb) => qb.where('assets.isFavorite', '=', options.isFavorite!))
      .$if(!!options.withStacked, (qb) => withStack(qb, { assets: true })) // TODO: optimize this; it's a huge performance hit
      .$if(!!options.assetType, (qb) => qb.where('assets.type', '=', options.assetType!))
      .$if(options.isDuplicate !== undefined, (qb) =>
        qb.where('assets.duplicateId', options.isDuplicate ? 'is not' : 'is', null),
      )
      .where('assets.deletedAt', options.isTrashed ? 'is not' : 'is', null)
      .where('assets.isVisible', '=', true)
      .where(
        (eb) => eb.fn('date_trunc', [eb.val(options.size), sql`assets."localDateTime" AT TIME ZONE 'UTC'`]),
        '=',
        timeBucket.replace(/^[+-]/, ''),
      )
      .orderBy('assets.localDateTime', 'desc')
      .execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [{ userIds: [DummyValue.UUID, DummyValue.UUID] }] })
  getDuplicates(userId: string): Promise<DuplicateGroup[]> {
    return this.db
      .selectFrom('assets')
      .select('duplicateId')
      .select((eb) => eb.fn('array_agg', [eb.table('assets')]).as('assets'))
      .where('ownerId', '=', asUuid(userId))
      .where('duplicateId', 'is not', null)
      .where('deletedAt', 'is', null)
      .where('isVisible', '=', true)
      .groupBy('duplicateId')
      .execute() as any as Promise<DuplicateGroup[]>;
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5, maxFields: 12 }] })
  async getAssetIdByCity(
    ownerId: string,
    { minAssetsPerField, maxFields }: AssetExploreFieldOptions,
  ): Promise<SearchExploreItem<string>> {
    const items = await this.db
      .with('cities', (qb) =>
        qb
          .selectFrom('exif')
          .select('city')
          .where('city', 'is not', null)
          .groupBy('city')
          .having((eb) => eb.fn('count', [eb.ref('assetId')]), '>=', minAssetsPerField),
      )
      .selectFrom('assets')
      .innerJoin('exif', 'assets.id', 'exif.assetId')
      .innerJoin('cities', 'exif.city', 'cities.city')
      .distinctOn('exif.city')
      .select(['assetId as data', 'exif.city as value'])
      .where('ownerId', '=', asUuid(ownerId))
      .where('isVisible', '=', true)
      .where('isArchived', '=', false)
      .where('type', '=', AssetType.IMAGE)
      .where('deletedAt', 'is', null)
      .limit(maxFields)
      .execute();

    return { fieldName: 'exifInfo.city', items: items as SearchExploreItemSet<string> };
  }

  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        lastId: DummyValue.UUID,
        updatedUntil: DummyValue.DATE,
        limit: 10,
      },
    ],
  })
  getAllForUserFullSync(options: AssetFullSyncOptions): Promise<AssetEntity[]> {
    const { ownerId, lastId, updatedUntil, limit } = options;
    return this.db
      .selectFrom('assets')
      .where('ownerId', '=', asUuid(ownerId))
      .where('isVisible', '=', true)
      .where('updatedAt', '<=', updatedUntil)
      .$if(!!lastId, (qb) => qb.where('id', '>', lastId!))
      .orderBy('id', 'asc')
      .limit(limit)
      .execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [{ userIds: [DummyValue.UUID], updatedAfter: DummyValue.DATE }] })
  async getChangedDeltaSync(options: AssetDeltaSyncOptions): Promise<AssetEntity[]> {
    return this.db
      .selectFrom('assets')
      .selectAll('assets')
      .select((eb) =>
        eb
          .selectFrom('asset_stack')
          .select((eb) => eb.fn.countAll().as('stackedAssetsCount'))
          .whereRef('asset_stack.id', '=', 'assets.stackId')
          .as('stackedAssetsCount'),
      )
      .where('ownerId', '=', anyUuid(options.userIds))
      .where('isVisible', '=', true)
      .where('updatedAt', '>', options.updatedAfter)
      .limit(options.limit)
      .execute() as any as Promise<AssetEntity[]>;
  }

  async getUniqueOriginalPaths(userId: string): Promise<string[]> {
    const results = await this.db
      .selectFrom('assets')
      .select((eb) => eb.fn<string>('substring', ['assets.originalPath', eb.val('^(.*/)[^/]*$')]).as('directoryPath'))
      .distinct()
      .where('ownerId', '=', asUuid(userId))
      .where('isVisible', '=', true)
      .where('isArchived', '=', false)
      .where('deletedAt', 'is', null)
      .execute();

    return results.map((row) => row.directoryPath.replaceAll(/^\/|\/$/g, ''));
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async getAssetsByOriginalPath(userId: string, partialPath: string): Promise<AssetEntity[]> {
    const normalizedPath = partialPath.replaceAll(/^\/|\/$/g, '');

    const assets = this.db
      .selectFrom('assets')
      .selectAll('assets')
      .where('ownerId', '=', asUuid(userId))
      .where('isVisible', '=', true)
      .where('isArchived', '=', false)
      .where('deletedAt', 'is', null)
      .where('originalPath', 'like', `%${normalizedPath}/%`)
      .where('originalPath', 'not like', `%${normalizedPath}/%/%`)
      .orderBy(
        (eb) => eb.fn('regexp_replace', ['assets.originalPath', eb.val('.*/(.+)'), eb.val(String.raw`\1`)]),
        'asc',
      );

    return withExif(assets).execute() as any as Promise<AssetEntity[]>;
  }

  @GenerateSql({ params: [{ assetId: DummyValue.UUID, type: AssetFileType.PREVIEW, path: '/path/to/file' }] })
  async upsertFile({ assetId, type, path }: { assetId: string; type: AssetFileType; path: string }): Promise<void> {
    await this.db
      .insertInto('asset_files')
      .values({ assetId, type, path })
      .onConflict((oc) => oc.columns(['assetId', 'type']).doUpdateSet({ path: (eb) => eb.ref('excluded.path') }))
      .execute();
  }
}
