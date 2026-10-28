import { randomUUID } from 'crypto';

import type {
  Group,
  DatabaseStore,
  PaginationParams,
  Response,
  GroupMembership,
  Records,
} from '../../typings';
import * as dbutils from '../../db/utils';
import { apiError, JacksonError } from '../../controller/error';
import { Base } from './Base';
import { indexNames } from './utils';
import { equal, equalityFilters, type ListQuery } from './query';

interface CreateGroupParams {
  directoryId: string;
  name: string;
  raw: any;
  id?: string;
}

export class Groups extends Base {
  constructor({ db, cursor }: { db: DatabaseStore; cursor?: boolean }) {
    super({ db, cursor });
  }

  // Create a new group
  public async create(params: CreateGroupParams): Promise<Response<Group>> {
    const { directoryId, name, raw, id: groupId } = params;

    const id = groupId || randomUUID();

    raw['id'] = id;

    const group: Group = {
      id,
      directoryId,
      name,
      raw,
    };

    try {
      const store = this.store('groups');
      if (await store.get(id)) throw new JacksonError('Group already exists.', 409);
      await store.put(
        id,
        group,
        {
          name: indexNames.directoryIdDisplayname,
          value: dbutils.keyFromParts(directoryId, name),
        },
        {
          name: indexNames.directoryId,
          value: directoryId,
        }
      );

      return { data: group, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  /**
   * @openapi
   * components:
   *   schemas:
   *     Group:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *           description: Group ID
   *         name:
   *           type: string
   *           description: Group name
   *         raw:
   *           type: object
   *           properties: {}
   *           description: Raw group attributes from the Identity Provider
   *     Member:
   *       type: object
   *       properties:
   *         user_id:
   *           type: string
   *           description: ID of the user
   *   parameters:
   *     groupId:
   *       name: groupId
   *       in: path
   *       description: Group ID
   *       required: true
   *       schema:
   *         type: string
   *
   */

  /**
   * @openapi
   * /api/v1/dsync/groups/{groupId}:
   *   get:
   *     tags:
   *       - Directory Sync
   *     summary: Get group by id from a directory
   *     parameters:
   *       - name: tenant
   *         in: query
   *         description: Tenant (Optional if directoryId is provided)
   *         schema:
   *           type: string
   *       - name: product
   *         in: query
   *         description: Product (Optional if directoryId is provided)
   *         schema:
   *           type: string
   *       - name: directoryId
   *         in: query
   *         description: Directory ID (Optional if tenant/product is provided)
   *         schema:
   *           type: string
   *       - name: groupId
   *         in: path
   *         description: Group ID
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/Group"
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async get(id: string, directoryId?: string): Promise<Response<Group>> {
    try {
      const group = await this.store('groups').get(id);

      if (!group) {
        throw new JacksonError(`Group with id ${id} not found.`, 404);
      }

      if (directoryId) {
        if (!(await this.belongsToDirectory('groups', group, directoryId))) {
          throw new JacksonError('Group not found.', 404);
        }
        group.directoryId = directoryId;
      }

      return { data: group, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Update the group data
  public async update(
    id: string,
    param: {
      name: string;
      raw: any;
      directoryId?: string;
    }
  ): Promise<Response<Group>> {
    const { name, raw } = param;

    try {
      const saved = await this.get(id);
      if (saved.error || !saved.data) return saved;
      const group: Group = {
        ...saved.data,
        id,
        name,
        raw,
        directoryId: saved.data.directoryId || param.directoryId,
      };
      await this.store('groups').put(id, group);

      return { data: group, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Delete a group by id
  public async delete(id: string): Promise<Response<null>> {
    try {
      const { data, error } = await this.get(id);

      if (error || !data) {
        throw error;
      }

      await this.store('groups').delete(id);
      await this.removeAllUsers(id);

      return { data: null, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Add a user to a group
  public async addUserToGroup(groupId: string, userId: string) {
    const id = dbutils.keyDigest(dbutils.keyFromParts(groupId, userId));

    await this.store('members').put(
      id,
      {
        id: id,
        group_id: groupId,
        user_id: userId,
      },
      {
        name: indexNames.groupId,
        value: groupId,
      }
    );
  }

  // Remove a user from a group
  public async removeUserFromGroup(groupId: string, userId: string) {
    const id = dbutils.keyDigest(dbutils.keyFromParts(groupId, userId));

    await this.store('members').delete(id);
  }

  // Check if a user is a member of a group
  public async isUserInGroup(groupId: string, userId: string): Promise<boolean> {
    const id = dbutils.keyDigest(dbutils.keyFromParts(groupId, userId));

    return !!(await this.store('members').get(id));
  }

  // Search groups by displayName
  public async search(displayName: string, directoryId: string): Promise<Response<Group[]>> {
    try {
      const { data: groups } = await this.directoryPage<Group>(
        'groups',
        directoryId,
        { count: 1000 },
        (group) => equal(group.name, displayName)
      );

      return { data: groups, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  public async list(directoryId: string, query: ListQuery) {
    const filters = equalityFilters(query.filter, ['displayname', 'externalid']);
    return this.directoryPage<Group>('groups', directoryId, query, (group) =>
      filters.every(({ attribute, value }) =>
        attribute === 'displayname' ? equal(group.name, value) : equal(group.raw?.externalId, value, true)
      )
    );
  }

  public async assertUnique(name: string, directoryId: string, except?: string) {
    const { totalResults } = await this.directoryPage<Group>(
      'groups',
      directoryId,
      { count: 0 },
      (entry) => entry.id !== except && equal(entry.name, name)
    );
    if (totalResults) throw new JacksonError('Group already exists.', 409);
  }

  /**
   * @openapi
   * /api/v1/dsync/groups:
   *   get:
   *     tags:
   *       - Directory Sync
   *     summary: Get groups from a directory
   *     parameters:
   *       - $ref: '#/components/parameters/tenant'
   *       - $ref: '#/components/parameters/product'
   *       - $ref: '#/components/parameters/directoryId'
   *       - $ref: '#/components/parameters/pageOffset'
   *       - $ref: '#/components/parameters/pageLimit'
   *       - $ref: '#/components/parameters/pageToken'
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *              schema:
   *                type: object
   *                properties:
   *                  data:
   *                    type: array
   *                    items:
   *                      $ref: '#/components/schemas/Group'
   *                  pageToken:
   *                    type: string
   *                    description: token for pagination
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async getAll(
    params: PaginationParams & {
      directoryId?: string;
    }
  ): Promise<Response<Group[]>> {
    const { pageOffset, pageLimit, pageToken, directoryId } = params;

    try {
      let result: Records;

      // Filter by directoryId
      if (directoryId) {
        const index = {
          name: indexNames.directoryId,
          value: directoryId,
        };

        result = await this.store('groups').getByIndex(index, pageOffset, pageLimit, pageToken);
      } else {
        result = await this.store('groups').getAll(pageOffset, pageLimit, pageToken);
      }

      return { data: result.data, error: null, pageToken: result.pageToken };
    } catch (err: any) {
      return apiError(err);
    }
  }

  /**
   * @openapi
   * /api/v1/dsync/groups/{groupId}/members:
   *   get:
   *     tags:
   *       - Directory Sync
   *     summary: Get list of members in a group
   *     parameters:
   *       - $ref: '#/components/parameters/tenant'
   *       - $ref: '#/components/parameters/product'
   *       - $ref: '#/components/parameters/groupId'
   *       - $ref: '#/components/parameters/directoryId'
   *       - $ref: '#/components/parameters/pageOffset'
   *       - $ref: '#/components/parameters/pageLimit'
   *       - $ref: '#/components/parameters/pageToken'
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *              schema:
   *                type: object
   *                properties:
   *                  data:
   *                    type: array
   *                    items:
   *                      $ref: '#/components/schemas/Member'
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async getGroupMembers(
    parmas: { groupId: string } & PaginationParams
  ): Promise<Response<Pick<GroupMembership, 'user_id'>[]>> {
    const { groupId, pageOffset, pageLimit, pageToken } = parmas;

    try {
      const { data, pageToken: nextPageToken } = (await this.store('members').getByIndex(
        {
          name: indexNames.groupId,
          value: groupId,
        },
        pageOffset,
        pageLimit,
        pageToken
      )) as { data: GroupMembership[]; pageToken?: string };

      const members = data.map((member) => {
        return {
          user_id: member.user_id,
        };
      });

      return { data: members, error: null, pageToken: nextPageToken };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Count the members of a group. Returns undefined when the configured store
  // does not support counting (e.g. the in-memory and DynamoDB stores).
  public async getGroupMembersCount(groupId: string): Promise<number | undefined> {
    return this.store('members').getCount({
      name: indexNames.groupId,
      value: groupId,
    });
  }

  // Delete all groups from a directory
  async deleteAll(directoryId: string) {
    while (true) {
      const { data: groups } = await this.store('groups').getByIndex(
        {
          name: indexNames.directoryId,
          value: directoryId,
        },
        0,
        this.bulkDeleteBatchSize
      );

      if (!groups || groups.length === 0) {
        break;
      }

      const keys = groups.map((group) => group.id);

      await this.store('groups').deleteMany(keys);

      for (const key of keys) {
        await this.removeAllUsers(key);
      }
    }
  }

  // Remove all users from a group
  public async removeAllUsers(groupId: string) {
    while (true) {
      const { data: members } = await this.store('members').getByIndex(
        {
          name: indexNames.groupId,
          value: groupId,
        },
        0,
        this.bulkDeleteBatchSize
      );

      if (!members || members.length === 0) {
        break;
      }

      await this.store('members').deleteMany(members.map((member) => member.id));
    }
  }
}
