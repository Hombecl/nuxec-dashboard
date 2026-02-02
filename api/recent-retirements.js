// Recent Retirements API for nuxec-dashboard
// Fetches recently retired products and pending retirements from Airtable

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = 'appRCQASsApV4C33N';
const TABLE_ID = 'tblo1uuy8Nc9CSjX4';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!AIRTABLE_API_KEY) {
      return res.status(500).json({ success: false, error: 'Airtable API key not configured' });
    }

    // Calculate date 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString();

    // Filter: Recently retired OR pending retirement
    const filterFormula = `OR(
      AND(
        FIND('Retired', {WM Publish Status}) > 0,
        {WM Last Verification} >= '${sevenDaysAgoStr}'
      ),
      AND(
        {Retire Reason} != '',
        OR({Store} = 'WM19', {Store} = 'WM24', {Store} = 'WM33')
      )
    )`;

    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set('filterByFormula', filterFormula);
    url.searchParams.set('sort[0][field]', 'WM Last Verification');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('maxRecords', '100');

    // Fields to fetch
    ['SKU', 'Product ID', 'Store', 'Title', 'WM Publish Status', 'WM Last Verification',
     '14-Day Sales', '7-Day Sales', 'Approved Base Price', 'Product Cost', 'Retire Reason']
      .forEach(field => url.searchParams.append('fields[]', field));

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Failed to fetch from Airtable');
    }

    const data = await response.json();
    const records = data.records || [];

    // Process records
    const retiredProducts = [];
    const pendingRetirements = [];
    const reasonBreakdown = {};
    const byStore = {};
    let totalLostSales14Day = 0;
    let totalLostRevenue = 0;
    let withSalesCount = 0;

    for (const record of records) {
      const f = record.fields;
      const publishStatus = f['WM Publish Status'] || '';
      const isRetired = publishStatus.toLowerCase().includes('retired');
      const isPending = !isRetired && f['Retire Reason'];

      // Extract retire reason
      let retireReason = f['Retire Reason'] || '';
      if (!retireReason && isRetired) {
        const match = publishStatus.match(/Retired\s*\(([^)]+)\)/i);
        retireReason = match ? match[1] : 'Unknown';
      }

      const sales14Day = f['14-Day Sales'] || 0;
      const sellingPrice = f['Approved Base Price'] || 0;
      const estimatedRevenue = sales14Day * sellingPrice;

      const product = {
        id: record.id,
        sku: f.SKU || '',
        productId: f['Product ID'] || '',
        title: f.Title || f.SKU || 'Unknown',
        store: f.Store || 'Unknown',
        publishStatus,
        retireReason,
        retireDate: f['WM Last Verification'] || null,
        sales14Day,
        sales7Day: f['7-Day Sales'] || 0,
        estimatedRevenue,
        sellingPrice,
      };

      if (isPending) {
        pendingRetirements.push(product);
      } else if (isRetired) {
        retiredProducts.push(product);

        // Aggregate stats
        if (sales14Day > 0) {
          withSalesCount++;
          totalLostSales14Day += sales14Day;
          totalLostRevenue += estimatedRevenue;
        }

        // Count by reason
        const reason = retireReason || 'Unknown';
        reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;

        // Count by store
        const store = f.Store || 'Unknown';
        byStore[store] = (byStore[store] || 0) + 1;
      }
    }

    const summary = {
      totalRetired: retiredProducts.length,
      pendingCount: pendingRetirements.length,
      withSalesCount,
      totalLostSales14Day,
      totalLostRevenue,
      reasonBreakdown,
      byStore,
      lastUpdate: new Date().toISOString(),
    };

    return res.status(200).json({
      success: true,
      summary,
      retiredProducts,
      pendingRetirements,
    });

  } catch (error) {
    console.error('Recent retirements API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch retirement data'
    });
  }
}
