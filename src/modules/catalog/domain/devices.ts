import type { ShopDevice } from '../application/ports.js';

export function mergeShopDevices(input: {
  sessions: { deviceId: string; deviceName: string | null; userId: string; createdAt: Date }[];
  commands: { deviceId: string; createdAt: Date | null }[];
  cursors: { deviceId: string; updatedAt: Date }[];
  names: Map<string, string>;
  fallbackName: string;
}): ShopDevice[] {
  const grouped = new Map<string, ShopDevice>();
  const commandAt = new Map(
    input.commands.flatMap((command) => (command.createdAt ? [[command.deviceId, command.createdAt] as const] : [])),
  );
  for (const session of input.sessions) {
    if (grouped.has(session.deviceId)) {
      continue;
    }
    const commandSeen = commandAt.get(session.deviceId);
    const lastSeen = commandSeen && commandSeen > session.createdAt ? commandSeen : session.createdAt;
    grouped.set(session.deviceId, {
      deviceId: session.deviceId,
      deviceName: session.deviceName ?? 'Device',
      memberName: input.names.get(session.userId) ?? '',
      lastSeenAt: lastSeen.toISOString(),
    });
  }
  const touch = (deviceId: string, seen: Date) => {
    const current = grouped.get(deviceId);
    if (!current) {
      grouped.set(deviceId, {
        deviceId,
        deviceName: 'Device',
        memberName: input.fallbackName,
        lastSeenAt: seen.toISOString(),
      });
      return;
    }
    if (seen.toISOString() > current.lastSeenAt) {
      current.lastSeenAt = seen.toISOString();
    }
  };
  for (const command of input.commands) {
    if (command.createdAt) {
      touch(command.deviceId, command.createdAt);
    }
  }
  for (const cursor of input.cursors) {
    touch(cursor.deviceId, cursor.updatedAt);
  }
  return [...grouped.values()];
}
