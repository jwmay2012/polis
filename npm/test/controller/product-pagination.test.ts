import tap from 'tap';
import { ConnectionAPIController } from '../../src/controller/api';
import { IndexNames } from '../../src/controller/utils';

for (const nextPageToken of ['next-page', undefined]) {
  tap.test(`product lookup returns the store cursor: ${nextPageToken || 'finished'}`, async (t) => {
    let requestedToken: string | undefined;
    const controller = new ConnectionAPIController({
      connectionStore: {
        getByIndex: async (index, offset, limit, pageToken) => {
          t.same(index, { name: IndexNames.Product, value: 'example-product' });
          t.equal(offset, 20);
          t.equal(limit, 10);
          requestedToken = pageToken;
          return {
            data: [{ clientID: 'connection', tenant: 'example.test', product: 'example-product' }],
            pageToken: nextPageToken,
          };
        },
      },
      opts: {},
      eventController: {},
    });

    const result = await controller.getConnectionsByProduct({
      product: 'example-product',
      pageOffset: 20,
      pageLimit: 10,
      pageToken: 'incoming-page',
    });

    t.equal(requestedToken, 'incoming-page', 'passes the request cursor to the store');
    t.equal(result.pageToken, nextPageToken, 'returns the next cursor, not the request cursor');
    t.match(result.data, [{ clientID: 'connection', deactivated: false }], 'still transforms the records');
  });
}
