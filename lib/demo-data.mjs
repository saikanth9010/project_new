import { inTransaction } from './db.mjs';

const siteRows = [
  ['Harbour Centre', '181 Bay Street', 'Toronto', 'ON', 'Commercial office tower', 'Harbour Property Group', 'Facilities desk', '(416) 555-0198', '6:00 AM–6:00 AM'],
  ['Lakeside Distribution', '80 Unwin Avenue', 'Toronto', 'ON', 'Distribution facility', 'Lakeside Logistics', 'Site office', '(416) 555-0158', '24 hours'],
  ['Westgate Offices', '1234 Dundas Street West', 'Toronto', 'ON', 'Commercial offices', 'Westgate Property', 'Reception', '(416) 555-0122', '6:00 AM–6:00 AM'],
];

const officerRows = [
  ['G-1042', 'Maya Chen', 'MC', 'Security officer', 'On post', 'East lobby', 86, 0, 'sage'],
  ['G-1088', 'Jordan Lee', 'JL', 'Field supervisor', 'Available', 'Control room', 72, 2, 'blue'],
  ['G-1116', 'Avery Brooks', 'AB', 'Security officer', 'On patrol', 'Perimeter route', 54, 4, 'sand'],
  ['G-1173', 'Noah Patel', 'NP', 'Security officer', 'Available', 'Mobile unit 02', 93, 1, 'lilac'],
  ['G-1190', 'Elena Ruiz', 'ER', 'Security officer', 'On post', 'Reception', 68, 3, 'rose'],
];

const incidentRows = [
  ['INC-2471', 'Medical assistance requested', 'MEDICAL', 'critical', 'Harbour Centre', 'Level 12 · East lift lobby', 'A visitor requested medical assistance near the east elevators. This is fictional seed data. Replace it before operational use.', 'open', null, 12],
  ['INC-2470', 'Loading bay access alarm', 'ACCESS CONTROL', 'high', 'Harbour Centre', 'Loading bay · South entrance', 'Door contact alarm was triggered at the south loading bay. This is fictional seed data.', 'assigned', 'G-1088', 19],
  ['INC-2468', 'Noise complaint', 'TENANT REQUEST', 'medium', 'Harbour Centre', 'Level 8 · Suite 810', 'A tenant reported repeated noise from the west corridor. This is fictional seed data.', 'open', null, 31],
  ['INC-2466', 'Unsecured stairwell door', 'PATROL EXCEPTION', 'high', 'Lakeside Distribution', 'Stairwell C · Level 2', 'Patrol scan noted the stairwell door was not latched. This is fictional seed data.', 'assigned', 'G-1116', 48],
];

const tourRows = [
  ['Harbour Centre · Perimeter sweep', 'Harbour Centre', 'G-1042', 'Night shift', '7:30 PM – 9:00 PM', ['East lobby', 'Loading bay', 'Parking B2', 'Roof access'], 2, 'in_progress'],
  ['Lakeside · Closing patrol', 'Lakeside Distribution', 'G-1116', 'Evening shift', '7:00 PM – 8:15 PM', ['Gate 1', 'Dock doors', 'West fence', 'Stairwell C', 'Office wing'], 3, 'exception'],
  ['Westgate · Reception rounds', 'Westgate Offices', 'G-1190', 'Night shift', '8:00 PM – 9:30 PM', ['Reception', 'Level 3', 'Parking P1', 'Fire panel'], 1, 'in_progress'],
];

const activityRows = [
  ['seed-checkpoint', 'Checkpoint verified', 'East lobby · Maya Chen', '✓', 7],
  ['seed-dispatch', 'Dispatch ticket assigned', 'INC-2470 · Jordan Lee', '↗', 10],
  ['seed-shift', 'Shift started', 'Harbour Centre · Maya Chen', '◷', 18],
  ['seed-report', 'Incident report submitted', 'Unsecured stairwell door · Lakeside', '!', 24],
];

function mustInsert(result, message) {
  if (!result.rowCount) throw new Error(message);
  return result.rows[0];
}

export async function seedDemoData(pool, tenantId) {
  return inTransaction(pool, tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ['northstar-demo-seed:' + tenantId]);
    const sites = new Map();
    for (const row of siteRows) {
      const result = await client.query(
        'INSERT INTO sites(tenant_id, name, address, city, region, site_type, client_name, contact_name, contact_phone, contract_window, is_demo) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true) ' +
        'ON CONFLICT (tenant_id, name) DO UPDATE SET address = EXCLUDED.address, city = EXCLUDED.city, region = EXCLUDED.region, site_type = EXCLUDED.site_type, client_name = EXCLUDED.client_name, contact_name = EXCLUDED.contact_name, contact_phone = EXCLUDED.contact_phone, contract_window = EXCLUDED.contract_window ' +
        'WHERE sites.is_demo = true RETURNING id', [tenantId, ...row],
      );
      const site = mustInsert(result, 'A sample site name is already used by a non-demo record. No demo data was changed.');
      sites.set(row[0], site.id);
    }

    const officers = new Map();
    for (const row of officerRows) {
      const siteName = row[0] === 'G-1116' ? 'Lakeside Distribution' : row[0] === 'G-1190' ? 'Westgate Offices' : 'Harbour Centre';
      const result = await client.query(
        'INSERT INTO officers(tenant_id, site_id, officer_code, name, initials, role, status, post, battery, last_seen_at, color, is_demo) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - ($10::text || ' minutes')::interval, $11, true) " +
        'ON CONFLICT (tenant_id, officer_code) DO UPDATE SET site_id = EXCLUDED.site_id, status = EXCLUDED.status, post = EXCLUDED.post, battery = EXCLUDED.battery, last_seen_at = EXCLUDED.last_seen_at, color = EXCLUDED.color ' +
        'WHERE officers.is_demo = true RETURNING id',
        [tenantId, sites.get(siteName), ...row.slice(0, 8), row[8]],
      );
      const officer = mustInsert(result, 'A sample officer code is already used by a non-demo record. No demo data was changed.');
      officers.set(row[0], officer.id);
    }

    for (const row of incidentRows) {
      const result = await client.query(
        'INSERT INTO incidents(tenant_id, incident_code, title, incident_type, severity, site_id, location, description, status, assigned_officer_id, opened_at, is_demo) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - ($11::text || ' minutes')::interval, true) " +
        'ON CONFLICT (incident_code) DO UPDATE SET title = EXCLUDED.title, incident_type = EXCLUDED.incident_type, severity = EXCLUDED.severity, site_id = EXCLUDED.site_id, location = EXCLUDED.location, description = EXCLUDED.description, status = EXCLUDED.status, assigned_officer_id = EXCLUDED.assigned_officer_id, opened_at = EXCLUDED.opened_at, updated_at = now() ' +
        'WHERE incidents.is_demo = true RETURNING id',
        [tenantId, row[0], row[1], row[2], row[3], sites.get(row[4]), row[5], row[6], row[7], row[8] ? officers.get(row[8]) : null, row[9]],
      );
      mustInsert(result, 'A sample incident code is already used by a non-demo record. No demo data was changed.');
    }

    for (const tour of tourRows) {
      const current = await client.query('SELECT id, is_demo FROM patrol_tours WHERE tenant_id = $1 AND name = $2 FOR UPDATE', [tenantId, tour[0]]);
      if (current.rowCount && !current.rows[0].is_demo) throw new Error('A sample patrol name is already used by a non-demo record. No demo data was changed.');
      if (current.rowCount) {
        await client.query(
          'UPDATE patrol_tours SET site_id = $1, officer_id = $2, shift_label = $3, window_label = $4, checkpoint_names = $5::jsonb, completed_checkpoints = $6, status = $7 WHERE id = $8 AND tenant_id = $9',
          [sites.get(tour[1]), officers.get(tour[2]), tour[3], tour[4], JSON.stringify(tour[5]), tour[6], tour[7], current.rows[0].id, tenantId],
        );
      } else {
        await client.query(
          'INSERT INTO patrol_tours(tenant_id, site_id, officer_id, name, shift_label, window_label, checkpoint_names, completed_checkpoints, status, is_demo) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, true)',
          [tenantId, sites.get(tour[1]), officers.get(tour[2]), tour[0], tour[3], tour[4], JSON.stringify(tour[5]), tour[6], tour[7]],
        );
      }
    }

    for (const event of activityRows) {
      const result = await client.query(
        'INSERT INTO activity_events(tenant_id, event_key, title, detail, icon, occurred_at, is_demo) ' +
        "VALUES ($1, $2, $3, $4, $5, now() - ($6::text || ' minutes')::interval, true) " +
        'ON CONFLICT (event_key) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, icon = EXCLUDED.icon, occurred_at = EXCLUDED.occurred_at ' +
        'WHERE activity_events.is_demo = true RETURNING id',
        [tenantId, ...event],
      );
      mustInsert(result, 'A sample activity key is already used by a non-demo record. No demo data was changed.');
    }

    return { sites: siteRows.length, officers: officerRows.length, incidents: incidentRows.length, tours: tourRows.length, activity: activityRows.length };
  });
}

export async function removeDemoData(pool, user) {
  return inTransaction(pool, user.tenantId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ['northstar-demo-seed:' + user.tenantId]);
    const references = await client.query(
      'SELECT EXISTS (SELECT 1 FROM incidents i LEFT JOIN sites s ON s.id = i.site_id LEFT JOIN officers o ON o.id = i.assigned_officer_id WHERE i.tenant_id = $1 AND i.is_demo = false AND (s.is_demo = true OR o.is_demo = true)) ' +
      'OR EXISTS (SELECT 1 FROM patrol_tours p LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN officers o ON o.id = p.officer_id WHERE p.tenant_id = $1 AND p.is_demo = false AND (s.is_demo = true OR o.is_demo = true)) AS has_live_references',
      [user.tenantId],
    );
    if (references.rows[0].has_live_references) {
      throw new Error('Some sample sites or officers are linked to operational records. Reassign those records before removing demo data.');
    }

    const counts = {};
    for (const table of ['incidents', 'patrol_tours', 'officers', 'sites', 'activity_events']) {
      const result = await client.query('DELETE FROM ' + table + ' WHERE tenant_id = $1 AND is_demo = true', [user.tenantId]);
      counts[table] = result.rowCount;
    }
    await client.query(
      'INSERT INTO activity_events(tenant_id, actor_user_id, title, detail, icon) VALUES ($1, $2, $3, $4, $5)',
      [user.tenantId, user.id, 'Demo data removed', 'Fictional sample records were cleared by an administrator.', '✓'],
    );
    return counts;
  });
}
