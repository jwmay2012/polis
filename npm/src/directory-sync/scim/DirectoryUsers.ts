import crypto from 'crypto';
import type {
  Directory,
  DirectorySyncResponse,
  DirectorySyncRequest,
  User,
  ApiError,
  EventCallback,
  IDirectoryConfig,
  IUsers,
  UserPatchOperation,
} from '../../typings';
import {
  parseUserPatchRequest,
  extractStandardUserAttributes,
  updateRawUserAttributes,
  isSCIMEnabledProvider,
} from './utils';
import { sendEvent } from '../utils';
import { isConnectionActive } from '../../controller/utils';
import { randomUUID } from 'crypto';
import { apiError, JacksonError } from '../../controller/error';
import type { ListQuery } from './query';

interface DirectoryUsersParams {
  directories: IDirectoryConfig;
  users: IUsers;
}

export class DirectoryUsers {
  private directories: IDirectoryConfig;
  private users: IUsers;
  private callback: EventCallback | undefined;

  constructor({ directories, users }: DirectoryUsersParams) {
    this.directories = directories;
    this.users = users;
  }

  public async create(directory: Directory, body: any): Promise<DirectorySyncResponse> {
    const userAttributes = extractStandardUserAttributes(body);

    const newUser = {
      ...userAttributes,
      directoryId: directory.id,
      raw: structuredClone('rawAttributes' in body ? body.rawAttributes : body),
    };

    if (!newUser.id) {
      newUser.id = randomUUID();
    }

    newUser.raw['id'] = newUser.id;

    if (isSCIMEnabledProvider(directory.type)) {
      await this.users.assertUnique(newUser, directory.id);
    } else {
      // Google sync already supplies stable unique IDs; retain its indexed
      // email check rather than scanning the directory for every imported user.
      const found = await this.users.search(newUser.email, directory.id);
      if (found.error) return this.respondWithError(found.error);
      if (found.data?.length) return this.respondWithError({ code: 409, message: 'User already exists' });
    }
    const { data: user, error } = await this.users.create(newUser);
    if (error || !user) return this.respondWithError(error);

    await sendEvent('user.created', { directory, user }, this.callback);

    return {
      status: 201,
      data: user?.raw,
    };
  }

  public async get(user: User): Promise<DirectorySyncResponse> {
    return {
      status: 200,
      data: user.raw,
    };
  }

  public async update(directory: Directory, user: User, body: any): Promise<DirectorySyncResponse> {
    const userAttributes = extractStandardUserAttributes(body);

    const replacement = {
      ...userAttributes,
      id: user.id,
      directoryId: directory.id,
      raw: 'rawAttributes' in body ? body.rawAttributes : body,
    };
    if (isSCIMEnabledProvider(directory.type))
      await this.users.assertUnique(replacement, directory.id, user.id);
    const { data: updatedUser, error } = await this.users.update(user.id, replacement);
    if (error || !updatedUser) return this.respondWithError(error);

    await sendEvent('user.updated', { directory, user: updatedUser }, this.callback);

    return {
      status: 200,
      data: updatedUser?.raw,
    };
  }

  public async patch(directory: Directory, user: User, body: any): Promise<DirectorySyncResponse> {
    const { Operations } = body as { Operations: UserPatchOperation[] };

    let attributes: Partial<User> = {};
    let rawAttributes = {};

    // There can be multiple update operations in a single request for a user
    for (const operation of Operations) {
      const parsedAttributes = parseUserPatchRequest(operation);

      attributes = {
        ...attributes,
        ...parsedAttributes.attributes,
      };

      rawAttributes = {
        ...rawAttributes,
        ...parsedAttributes.rawAttributes,
      };
    }

    const replacement = {
      ...user,
      ...attributes,
      raw: updateRawUserAttributes(structuredClone(user.raw), rawAttributes),
    };
    await this.users.assertUnique(replacement, directory.id, user.id);
    const { data: updatedUser, error } = await this.users.update(user.id, replacement);
    if (error || !updatedUser) return this.respondWithError(error);

    await sendEvent('user.updated', { directory, user: updatedUser }, this.callback);

    return {
      status: 200,
      data: updatedUser?.raw,
    };
  }

  public async delete(directory: Directory, user: User): Promise<DirectorySyncResponse> {
    const { error } = await this.users.delete(user.id);
    if (error) return this.respondWithError(error);

    await sendEvent('user.deleted', { directory, user }, this.callback);

    return {
      status: 200,
      data: user.raw,
    };
  }

  public async getAll(queryParams: ListQuery & { directoryId: string }): Promise<DirectorySyncResponse> {
    const {
      data: users,
      totalResults,
      startIndex,
    } = await this.users.list(queryParams.directoryId, queryParams);

    return {
      status: 200,
      data: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
        startIndex,
        totalResults,
        itemsPerPage: users.length,
        Resources: users.map((user) => user.raw),
      },
    };
  }

  private respondWithError(error: ApiError | null, scimType?: string) {
    return {
      status: error ? error.code : 500,
      data: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        detail: error ? error.message : 'Internal Server Error',
        ...(scimType ? { scimType } : error?.code === 409 ? { scimType: 'uniqueness' } : {}),
      },
    };
  }

  // Handle the request from the Identity Provider and route it to the appropriate method
  public async handleRequest(
    request: DirectorySyncRequest,
    callback?: EventCallback
  ): Promise<DirectorySyncResponse> {
    const scoped: this = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    try {
      return await scoped.handleScopedRequest(request, callback);
    } catch (error) {
      return this.respondWithError(
        apiError(error).error,
        error instanceof JacksonError ? error.internalError : undefined
      );
    }
  }

  private async handleScopedRequest(
    request: DirectorySyncRequest,
    callback?: EventCallback
  ): Promise<DirectorySyncResponse> {
    const { body, query, resourceId: userId, directoryId, apiSecret } = request;

    const method = request.method.toUpperCase();

    // Get the directory
    const { data: directory, error } = await this.directories.get(directoryId);

    if (error) {
      return this.respondWithError(error);
    }

    if (!directory) {
      return {
        status: 200,
        data: {},
      };
    }

    if (!isConnectionActive(directory)) {
      return {
        status: 200,
        data: {},
      };
    }

    // Validate the request
    try {
      if (!crypto.timingSafeEqual(Buffer.from(directory.scim.secret), Buffer.from(apiSecret || ''))) {
        return this.respondWithError({ code: 401, message: 'Unauthorized' });
      }
    } catch {
      return this.respondWithError({ code: 401, message: 'Unauthorized' });
    }

    this.callback = callback;
    this.users = this.users.setTenantAndProduct(directory.tenant, directory.product);

    // Get the user
    const found = userId ? await this.users.get(userId, directory.id) : { data: null, error: null };
    if (found.error) return this.respondWithError(found.error);
    const user = found.data;

    // Delete password if exists in the body
    if (body && 'password' in body) {
      delete body['password'];
    }

    if (userId && !user) {
      return this.respondWithError({ code: 404, message: 'User not found' });
    }

    if (user) {
      switch (method) {
        case 'GET':
          return await this.get(user);
        case 'PATCH':
          return await this.patch(directory, user, body);
        case 'PUT':
          return await this.update(directory, user, body);
        case 'DELETE':
          return await this.delete(directory, user);
      }
    }

    switch (method) {
      case 'POST':
        return await this.create(directory, body);
      case 'GET':
        return await this.getAll({
          count: query.count,
          startIndex: query.startIndex,
          filter: query.filter,
          directoryId,
        });
    }

    return this.respondWithError({ code: 404, message: 'Not found' });
  }
}
