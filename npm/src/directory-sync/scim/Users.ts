import type { User, DatabaseStore, PaginationParams, Response, Records } from '../../typings';
import { apiError, JacksonError } from '../../controller/error';
import { Base } from './Base';
import { keyFromParts } from '../../db/utils';
import { indexNames } from './utils';
import { equal, equalityFilters, type ListQuery } from './query';

export class Users extends Base {
  constructor({ db, cursor }: { db: DatabaseStore; cursor?: boolean }) {
    super({ db, cursor });
  }

  // Create a new user
  public async create(user: User & { directoryId: string }): Promise<Response<User>> {
    const { directoryId, id, email } = user;

    try {
      const store = this.store('users');
      if (await store.get(id)) throw new JacksonError('User already exists.', 409);
      await store.put(
        id,
        user,
        {
          name: indexNames.directoryIdUsername,
          value: keyFromParts(directoryId, email),
        },
        {
          name: indexNames.directoryId,
          value: directoryId,
        }
      );

      return { data: user, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  /**
   * @openapi
   * components:
   *   schemas:
   *     User:
   *       type: object
   *       properties:
   *         id:
   *           type: string
   *           description: User ID
   *         first_name:
   *           type: string
   *           description: First name
   *         last_name:
   *           type: string
   *           description: Last name
   *         email:
   *           type: string
   *           description: Email address
   *         active:
   *           type: boolean
   *           description: Indicates whether the user is active or not
   *         raw:
   *           type: object
   *           properties: {}
   *           description: Raw user attributes from the Identity Provider
   *
   */

  /**
   * @openapi
   * /api/v1/dsync/users/{userId}:
   *   get:
   *     tags:
   *       - Directory Sync
   *     summary: Get user by id from a directory
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
   *       - name: userId
   *         in: path
   *         description: User ID
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/User"
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async get(id: string, directoryId?: string): Promise<Response<User>> {
    try {
      const user = await this.store('users').get(id);

      if (user === null) {
        throw new JacksonError('User not found', 404);
      }

      if (directoryId) {
        if (!(await this.belongsToDirectory('users', user, directoryId))) {
          throw new JacksonError('User not found', 404);
        }
        user.directoryId = directoryId;
      }

      return { data: user, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Update the user data
  public async update(id: string, user: User): Promise<Response<User>> {
    const { raw } = user;

    raw['id'] = id;

    try {
      const saved = await this.get(id);
      if (saved.error || !saved.data) return saved;
      const updatedUser = {
        ...user,
        directoryId: saved.data.directoryId || user.directoryId,
        raw,
      };
      const indexes = updatedUser.directoryId
        ? [
            {
              name: indexNames.directoryIdUsername,
              value: keyFromParts(updatedUser.directoryId, updatedUser.email),
            },
          ]
        : [];
      await this.store('users').put(id, updatedUser, ...indexes);
      return { data: updatedUser, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Delete a user by id
  public async delete(id: string): Promise<Response<null>> {
    try {
      const { data, error } = await this.get(id);

      if (error || !data) {
        throw error;
      }

      await this.store('users').delete(id);

      return { data: null, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // The management API's existing search argument is an email address.
  public async search(userName: string, directoryId: string): Promise<Response<User[]>> {
    try {
      const users: User[] = [];
      for await (const user of this.indexRecords(this.store('users'), {
        name: indexNames.directoryIdUsername,
        value: keyFromParts(directoryId, userName),
      })) {
        if ((!user.directoryId || user.directoryId === directoryId) && equal(user.email, userName))
          users.push(user);
      }

      return { data: users, error: null };
    } catch (err: any) {
      return apiError(err);
    }
  }

  public async list(directoryId: string, query: ListQuery) {
    const filters = equalityFilters(query.filter, [
      'username',
      'externalid',
      'emails.value',
      'emails[typeeq"work"].value',
    ]);
    return this.directoryPage<User>('users', directoryId, query, (user) =>
      filters.every(({ attribute, value }) => {
        if (attribute === 'username') return equal(user.raw?.userName, value);
        if (attribute === 'externalid') return equal(user.raw?.externalId, value, true);
        return (
          Array.isArray(user.raw?.emails) &&
          user.raw.emails.some(
            (email) =>
              equal(email.value, value) && (attribute === 'emails.value' || equal(email.type, 'work'))
          )
        );
      })
    );
  }

  public async assertUnique(user: User, directoryId: string, previous?: User) {
    if (
      previous &&
      equal(user.email, previous.email) &&
      (user.raw?.userName === previous.raw?.userName || equal(user.raw?.userName, previous.raw?.userName))
    )
      return;
    const { totalResults } = await this.directoryPage<User>(
      'users',
      directoryId,
      { count: 0 },
      (entry) =>
        entry.id !== previous?.id &&
        (equal(entry.email, user.email) ||
          (typeof user.raw?.userName === 'string' && equal(entry.raw?.userName, user.raw.userName)))
    );
    if (totalResults) throw new JacksonError('User already exists.', 409);
  }

  /**
   * @openapi
   * /api/v1/dsync/users:
   *   get:
   *     tags:
   *       - Directory Sync
   *     summary: Get users from a directory
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
   *                      $ref: '#/components/schemas/User'
   *                  pageToken:
   *                    type: string
   *                    description: token for pagination
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async getAll({
    pageOffset,
    pageLimit,
    pageToken,
    directoryId,
  }: PaginationParams & {
    directoryId?: string;
  } = {}): Promise<Response<User[]>> {
    try {
      let result: Records;
      // Filter by directoryId
      if (directoryId) {
        result = await this.store('users').getByIndex(
          {
            name: indexNames.directoryId,
            value: directoryId,
          },
          pageOffset,
          pageLimit,
          pageToken
        );
      } else {
        result = await this.store('users').getAll(pageOffset, pageLimit, pageToken);
      }

      return { data: result.data, error: null, pageToken: result.pageToken };
    } catch (err: any) {
      return apiError(err);
    }
  }

  // Delete all users from a directory
  async deleteAll(directoryId: string) {
    while (true) {
      const { data: users } = await this.store('users').getByIndex(
        {
          name: indexNames.directoryId,
          value: directoryId,
        },
        0,
        this.bulkDeleteBatchSize
      );

      if (!users || users.length === 0) {
        break;
      }

      await this.store('users').deleteMany(users.map((user) => user.id));
    }
  }
}
