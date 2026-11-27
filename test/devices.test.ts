import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeShopDevices } from '../src/modules/catalog/domain/devices.js';

describe('shop devices', () => {
  it('lists a phone that synced without a login session', () => {
    const devices = mergeShopDevices({
      sessions: [],
      commands: [{ deviceId: 'phone-1', createdAt: new Date('2026-11-27T10:00:00Z') }],
      cursors: [{ deviceId: 'phone-2', updatedAt: new Date('2026-11-27T11:00:00Z') }],
      names: new Map(),
      fallbackName: 'Mya',
    });
    assert.deepEqual(
      devices.map((device) => device.deviceId),
      ['phone-1', 'phone-2'],
    );
    assert.equal(devices[0]?.memberName, 'Mya');
    assert.equal(devices[1]?.memberName, 'Mya');
  });

  it('keeps the signed-in device name when that phone has also synced', () => {
    const devices = mergeShopDevices({
      sessions: [
        {
          deviceId: 'phone-1',
          deviceName: 'Android device',
          userId: 'owner',
          createdAt: new Date('2026-11-27T09:00:00Z'),
        },
      ],
      commands: [{ deviceId: 'phone-1', createdAt: new Date('2026-11-27T12:00:00Z') }],
      cursors: [],
      names: new Map([['owner', 'Mya']]),
      fallbackName: 'Mya',
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.deviceName, 'Android device');
    assert.equal(devices[0]?.memberName, 'Mya');
    assert.equal(devices[0]?.lastSeenAt, '2026-11-27T12:00:00.000Z');
  });
});
