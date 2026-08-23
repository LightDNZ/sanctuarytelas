function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function percentile(values, fraction) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  return valid[Math.min(valid.length - 1, Math.floor(valid.length * fraction))];
}

function addTraffic(target, source) {
  for (const key of [
    'receivedBytes',
    'transmittedBytes',
    'droppedBytes',
    'receivedBytesPerSecond',
    'transmittedBytesPerSecond',
    'droppedBytesPerSecond',
  ]) {
    target[key] = (target[key] ?? 0) + (source?.[key] ?? 0);
  }
}

function emptyTraffic() {
  return {
    receivedBytes: 0,
    transmittedBytes: 0,
    droppedBytes: 0,
    receivedBytesPerSecond: 0,
    transmittedBytesPerSecond: 0,
    droppedBytesPerSecond: 0,
  };
}

export function buildAdminDashboard({ roomState, sockets, system, configuration }) {
  const rooms = roomState.rooms;
  const users = new Map();
  const guilds = new Map();
  const streams = [];

  for (const room of rooms) {
    let guild = null;
    if (room.guildId) {
      guild = guilds.get(room.guildId);
      if (!guild) {
        guild = {
          id: room.guildId,
          name: room.guildName ?? null,
          rooms: 0,
          calls: 0,
          users: new Set(),
          connections: 0,
          streams: 0,
          traffic: emptyTraffic(),
        };
        guilds.set(room.guildId, guild);
      }
      if (room.guildName) guild.name = room.guildName;
      guild.rooms++;
      if (room.isCall) guild.calls++;
      guild.connections += room.connections;
      guild.streams += room.streams.length;
      addTraffic(guild.traffic, room.traffic);
    }

    for (const user of room.users) {
      let aggregate = users.get(user.id);
      if (!aggregate) {
        aggregate = {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
          guilds: new Set(),
          rooms: new Set(),
          roles: new Set(),
          connections: 0,
          connectedAt: user.connectedAt,
          pings: [],
          broadcasting: false,
          mediaBytesOut: 0,
          bufferedBytes: 0,
        };
        users.set(user.id, aggregate);
      }

      aggregate.name = user.name || aggregate.name;
      aggregate.avatar = user.avatar ?? aggregate.avatar;
      aggregate.rooms.add(room.id);
      if (room.guildId) aggregate.guilds.add(room.guildId);
      for (const role of user.roles) aggregate.roles.add(role);
      aggregate.connections += user.connections;
      aggregate.connectedAt = Math.min(aggregate.connectedAt, user.connectedAt);
      if (Number.isFinite(user.pingMs)) aggregate.pings.push(user.pingMs);
      aggregate.broadcasting ||= user.broadcasting;
      aggregate.mediaBytesOut += user.mediaBytesOut;
      aggregate.bufferedBytes += user.bufferedBytes;
      guild?.users.add(user.id);
    }

    for (const stream of room.streams) {
      streams.push({
        ...stream,
        roomId: room.id,
        roomName: room.name,
        guildId: room.guildId,
        guildName: room.guildName,
        channelId: room.channelId,
      });
    }
  }

  const userList = [...users.values()]
    .map((user) => ({
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      guilds: [...user.guilds],
      rooms: [...user.rooms],
      roles: [...user.roles],
      connections: user.connections,
      connectedAt: user.connectedAt,
      pingMs: average(user.pings),
      broadcasting: user.broadcasting,
      mediaBytesOut: user.mediaBytesOut,
      bufferedBytes: user.bufferedBytes,
    }))
    .sort(
      (a, b) => Number(b.broadcasting) - Number(a.broadcasting) || a.name.localeCompare(b.name),
    );

  const guildList = [...guilds.values()]
    .map((guild) => ({
      ...guild,
      users: guild.users.size,
    }))
    .sort((a, b) => b.connections - a.connections);

  const pings = [...sockets].map((socket) => socket.__rttMs).filter(Number.isFinite);
  const activeWatchers = streams.reduce((sum, stream) => sum + stream.watchers, 0);

  return {
    generatedAt: Date.now(),
    startedAt: roomState.startedAt,
    configuration,
    summary: {
      users: userList.length,
      connections: sockets.size,
      viewerConnections: rooms.reduce((sum, room) => sum + room.viewers, 0),
      broadcasterConnections: rooms.reduce((sum, room) => sum + room.broadcasters, 0),
      activeWatchers,
      streams: streams.length,
      rooms: rooms.length,
      guilds: guildList.length,
      pingAverageMs: average(pings),
      pingMedianMs: percentile(pings, 0.5),
      pingP95Ms: percentile(pings, 0.95),
    },
    traffic: roomState.traffic,
    system,
    guilds: guildList,
    rooms,
    streams,
    users: userList,
  };
}
