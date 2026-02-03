// Vercel Serverless Function - Daily Check-up API
// Returns cached data from Airtable (updated every 6 hours by scheduled n8n workflow)

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const BASE_ID = 'appRCQASsApV4C33N';
    const TABLE_ID = 'tblo1uuy8Nc9CSjX4';

    if (!AIRTABLE_API_KEY) {
        return res.status(500).json({ error: 'AIRTABLE_API_KEY not configured' });
    }

    const { limit = '15', store, grouped = 'true' } = req.query;
    const isGrouped = grouped !== 'false' && (!store || store === 'all');

    try {
        // Build filter formula
        let filterFormula = "AND({14-Day Sales}>0, OR({Store}='WM19', {Store}='WM24'))";
        if (store && store !== 'all') {
            filterFormula = `AND({14-Day Sales}>0, {Store}='${store}')`;
        }

        // When grouping, fetch more records to ensure enough unique Product IDs
        const fetchLimit = isGrouped ? Math.max(parseInt(limit) * 3, 50) : parseInt(limit);

        const fields = [
            'SKU',
            'Product ID',
            'WM Product ID',  // Some records use this instead of 'Product ID'
            'Store',
            '7-Day Sales',
            '14-Day Sales',
            '3-Day Sales',
            'Title',
            'Walmart Listing URL',
            // Cost and margin fields from Airtable
            'Product Cost',
            'Approved Base Price',
            'Declared Price',
            'Primary Supplier Link',
            // Publish status from Airtable (synced by other workflows)
            'WM Publish Status',
            'WM Inventory',
            'WM FC Inventory',
            'WM Default Inventory',
            // Scrape data for sellers and pricing
            'Scrape Seller Name',
            'Scrape Price',
            'Scrape Current Price',
            'Scrape Total Sellers',
            'Scrape 3P Seller Count',
            'Scrape Price 3P',
            'Scrape Availability Status',
            'Scrape Out of Stock',
            'Scrape Rating',
            'Scrape Review Count',
            'Scrape Brand',
            'Scrape Low Stock Message',
            // Daily Check seller data
            'Daily Check All Sellers',
            'Daily Check Our Rank',
            'Daily Check Our Price',
            'Daily Check Lowest 3P Price',
            'Daily Check Is Winning',
            // Cached data timestamp (updated by scheduled workflow)
            'Daily Check Last Run',
        ];

        const airtableUrl = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
        airtableUrl.searchParams.set('filterByFormula', filterFormula);
        airtableUrl.searchParams.set('sort[0][field]', '14-Day Sales');
        airtableUrl.searchParams.set('sort[0][direction]', 'desc');
        airtableUrl.searchParams.set('maxRecords', String(fetchLimit));
        fields.forEach(field => airtableUrl.searchParams.append('fields[]', field));

        const airtableResponse = await fetch(airtableUrl.toString(), {
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        if (!airtableResponse.ok) {
            const errorData = await airtableResponse.json();
            return res.status(airtableResponse.status).json({
                error: errorData.error?.message || 'Failed to fetch from Airtable'
            });
        }

        const airtableData = await airtableResponse.json();
        const records = airtableData.records || [];

        // Find the most recent "Daily Check Last Run" timestamp across all records
        let lastDataUpdate = null;
        for (const record of records) {
            const lastRun = record.fields['Daily Check Last Run'];
            if (lastRun) {
                const runDate = new Date(lastRun);
                if (!lastDataUpdate || runDate > lastDataUpdate) {
                    lastDataUpdate = runDate;
                }
            }
        }

        // Process Airtable data
        const products = records.map((record) => {
            const f = record.fields;
            const sku = f.SKU || '';

            // Pricing data from Airtable
            const productCost = f['Product Cost'] || null;
            const ourSellingPrice = f['Approved Base Price'] || null;
            const declaredPrice = f['Declared Price'] || null;

            // Inventory from cached Airtable data (updated by FC inventory workflows)
            const fcInventory = f['WM FC Inventory'] || 0;
            const defaultInventory = f['WM Default Inventory'] || 0;
            // Use separate fields if available, fallback to combined WM Inventory
            const totalInventory = (fcInventory + defaultInventory) || f['WM Inventory'] || 0;

            // Publish status from Airtable
            const wmStatus = f['WM Publish Status'] || '';
            let publishedStatus;
            if (wmStatus.includes('PUBLISHED') || wmStatus.includes('ACTIVE')) {
                publishedStatus = 'PUBLISHED';
            } else if (wmStatus.includes('UNPUBLISHED') || wmStatus.includes('RETIRED')) {
                publishedStatus = 'UNPUBLISHED';
            } else {
                publishedStatus = wmStatus || 'Unknown';
            }

            // Walmart.com current price - from scrape data
            const walmartPrice = f['Scrape Current Price'] || f['Scrape Price'] || null;

            // Calculate Margin using correct formula:
            // Margin = Our Selling Price - Product Cost - $4.5 shipping - (Our Selling Price * 10.5% platform fee)
            let marginDollar = null;
            let marginPercent = null;
            if (ourSellingPrice && productCost) {
                const platformFee = ourSellingPrice * 0.105;
                const shippingCost = 4.5;
                marginDollar = ourSellingPrice - productCost - shippingCost - platformFee;
                marginPercent = marginDollar / ourSellingPrice;
            }

            // Inventory warning
            const inventoryWarning = totalInventory === 0;

            // Parse seller data from Airtable
            let sellers = [];
            try {
                if (f['Daily Check All Sellers']) {
                    sellers = JSON.parse(f['Daily Check All Sellers']);
                }
            } catch {
                sellers = [];
            }

            // Seller and competition data
            const totalSellers = f['Scrape Total Sellers'] || sellers.length || 1;
            const thirdPartySellers = f['Scrape 3P Seller Count'] || 0;
            const lowest3PPrice = f['Daily Check Lowest 3P Price'] || f['Scrape Price 3P'] || null;
            const ourRank = f['Daily Check Our Rank'] || null;
            const isWinning = f['Daily Check Is Winning'] || (ourSellingPrice && lowest3PPrice ? ourSellingPrice <= lowest3PPrice : false);

            return {
                id: record.id,
                sku,
                productId: f['Product ID'] || f['WM Product ID'] || '',
                title: f.Title || f.SKU || 'Unknown Product',
                store: f.Store || 'Unknown',
                sales7Day: f['7-Day Sales'] || 0,
                sales14Day: f['14-Day Sales'] || 0,
                sales3Day: f['3-Day Sales'] || 0,
                // Pricing from Airtable
                productCost,
                ourSellingPrice,
                declaredPrice,
                walmartPrice,
                // Real-time inventory from Walmart API
                defaultInventory,
                fcInventory,
                totalInventory,
                inventoryWarning,
                // Publish status (combined)
                publishedStatus,
                // Calculated margin
                marginDollar,
                marginPercent,
                // Competition data
                sellers,
                totalSellers,
                thirdPartySellers,
                lowest3PPrice,
                ourRank,
                isWinning,
                buyBoxSeller: f['Scrape Seller Name'] || 'Unknown',
                // Product info
                productName: f.Title,
                brand: f['Scrape Brand'] || null,
                rating: f['Scrape Rating'] || null,
                reviewCount: f['Scrape Review Count'] || 0,
                availability: f['Scrape Availability Status'] || 'Unknown',
                lowStockWarning: f['Scrape Low Stock Message'] || null,
                // Links
                supplierLink: f['Primary Supplier Link'] || null,
                walmartUrl: f['Walmart Listing URL'] || `https://www.walmart.com/ip/${f['Product ID']}`,
                // Timestamp - when this product's data was last updated by scheduled workflow
                lastChecked: f['Daily Check Last Run'] || null,
                isCached: true,
            };
        });

        // Group products by Product ID if grouped mode is enabled
        if (isGrouped) {
            // Step 1: Get unique Product IDs from products with sales
            const productIdsWithSales = [...new Set(
                products
                    .filter(p => p.productId) // Only those with valid Product ID
                    .map(p => p.productId)
            )];

            // Step 2: Fetch ALL SKUs for these Product IDs (including 0 sales from other stores)
            let allRelatedProducts = [...products]; // Start with what we have

            if (productIdsWithSales.length > 0) {
                // Build OR formula to fetch all related SKUs (check both Product ID and WM Product ID)
                const productIdConditions = productIdsWithSales.map(id => `OR({Product ID}='${id}', {WM Product ID}='${id}')`).join(', ');
                const relatedFilterFormula = `AND(OR(${productIdConditions}), OR({Store}='WM19', {Store}='WM24'))`;

                const relatedUrl = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
                relatedUrl.searchParams.set('filterByFormula', relatedFilterFormula);
                relatedUrl.searchParams.set('maxRecords', '200'); // Enough for related products
                fields.forEach(field => relatedUrl.searchParams.append('fields[]', field));

                try {
                    const relatedResponse = await fetch(relatedUrl.toString(), {
                        headers: {
                            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                            'Content-Type': 'application/json',
                        }
                    });

                    if (relatedResponse.ok) {
                        const relatedData = await relatedResponse.json();
                        const relatedRecords = relatedData.records || [];

                        // Process related records with same logic as main products
                        const relatedProducts = relatedRecords.map((record) => {
                            const f = record.fields;
                            const sku = f.SKU || '';
                            const productCost = f['Product Cost'] || null;
                            const ourSellingPrice = f['Approved Base Price'] || null;
                            const declaredPrice = f['Declared Price'] || null;
                            const fcInventory = f['WM FC Inventory'] || 0;
                            const defaultInventory = f['WM Default Inventory'] || 0;
                            const totalInventory = (fcInventory + defaultInventory) || f['WM Inventory'] || 0;
                            const wmStatus = f['WM Publish Status'] || '';
                            let publishedStatus;
                            if (wmStatus.includes('PUBLISHED') || wmStatus.includes('ACTIVE')) {
                                publishedStatus = 'PUBLISHED';
                            } else if (wmStatus.includes('UNPUBLISHED') || wmStatus.includes('RETIRED')) {
                                publishedStatus = 'UNPUBLISHED';
                            } else {
                                publishedStatus = wmStatus || 'Unknown';
                            }
                            const walmartPrice = f['Scrape Current Price'] || f['Scrape Price'] || null;
                            let marginDollar = null;
                            let marginPercent = null;
                            if (ourSellingPrice && productCost) {
                                const platformFee = ourSellingPrice * 0.105;
                                const shippingCost = 4.5;
                                marginDollar = ourSellingPrice - productCost - shippingCost - platformFee;
                                marginPercent = marginDollar / ourSellingPrice;
                            }
                            const inventoryWarning = totalInventory === 0;
                            let sellers = [];
                            try {
                                if (f['Daily Check All Sellers']) {
                                    sellers = JSON.parse(f['Daily Check All Sellers']);
                                }
                            } catch { sellers = []; }
                            const totalSellers = f['Scrape Total Sellers'] || sellers.length || 1;
                            const thirdPartySellers = f['Scrape 3P Seller Count'] || 0;
                            const lowest3PPrice = f['Daily Check Lowest 3P Price'] || f['Scrape Price 3P'] || null;
                            const ourRank = f['Daily Check Our Rank'] || null;
                            const isWinning = f['Daily Check Is Winning'] || (ourSellingPrice && lowest3PPrice ? ourSellingPrice <= lowest3PPrice : false);

                            return {
                                id: record.id,
                                sku,
                                productId: f['Product ID'] || f['WM Product ID'] || '',
                                title: f.Title || f.SKU || 'Unknown Product',
                                store: f.Store || 'Unknown',
                                sales7Day: f['7-Day Sales'] || 0,
                                sales14Day: f['14-Day Sales'] || 0,
                                sales3Day: f['3-Day Sales'] || 0,
                                productCost,
                                ourSellingPrice,
                                declaredPrice,
                                walmartPrice,
                                defaultInventory,
                                fcInventory,
                                totalInventory,
                                inventoryWarning,
                                publishedStatus,
                                marginDollar,
                                marginPercent,
                                sellers,
                                totalSellers,
                                thirdPartySellers,
                                lowest3PPrice,
                                ourRank,
                                isWinning,
                                buyBoxSeller: f['Scrape Seller Name'] || 'Unknown',
                                productName: f.Title,
                                brand: f['Scrape Brand'] || null,
                                rating: f['Scrape Rating'] || null,
                                reviewCount: f['Scrape Review Count'] || 0,
                                availability: f['Scrape Availability Status'] || 'Unknown',
                                lowStockWarning: f['Scrape Low Stock Message'] || null,
                                supplierLink: f['Primary Supplier Link'] || null,
                                walmartUrl: f['Walmart Listing URL'] || `https://www.walmart.com/ip/${f['Product ID']}`,
                                lastChecked: f['Daily Check Last Run'] || null,
                                isCached: true,
                            };
                        });

                        // Merge: use related products (more complete) and add any from original that aren't duplicates
                        const seenSkus = new Set(relatedProducts.map(p => p.sku));
                        const uniqueOriginal = products.filter(p => !seenSkus.has(p.sku));
                        allRelatedProducts = [...relatedProducts, ...uniqueOriginal];
                    }
                } catch (e) {
                    console.log('Failed to fetch related products:', e.message);
                    // Fall back to original products
                }
            }

            const groupMap = new Map();

            // Group all products by Product ID
            for (const product of allRelatedProducts) {
                const key = product.productId || product.sku; // Fallback to SKU if no Product ID
                if (!groupMap.has(key)) {
                    groupMap.set(key, []);
                }
                groupMap.get(key).push(product);
            }

            // Create ProductGroup objects
            const productGroups = [];
            for (const [productId, storeProducts] of groupMap.entries()) {
                // Use the first product for shared data (they're same listing)
                const firstProduct = storeProducts[0];

                // Aggregate sales across all stores
                const totalSales3Day = storeProducts.reduce((sum, p) => sum + p.sales3Day, 0);
                const totalSales7Day = storeProducts.reduce((sum, p) => sum + p.sales7Day, 0);
                const totalSales14Day = storeProducts.reduce((sum, p) => sum + p.sales14Day, 0);

                // Check status flags
                const hasInventoryWarning = storeProducts.some(p => p.inventoryWarning);
                const hasWinningStore = storeProducts.some(p => p.isWinning);

                // Get most recent lastChecked
                const lastChecked = storeProducts
                    .map(p => p.lastChecked)
                    .filter(Boolean)
                    .sort()
                    .reverse()[0] || null;

                productGroups.push({
                    productId,
                    title: firstProduct.title,
                    walmartUrl: firstProduct.walmartUrl,
                    totalSales3Day,
                    totalSales7Day,
                    totalSales14Day,
                    totalSellers: firstProduct.totalSellers,
                    thirdPartySellers: firstProduct.thirdPartySellers,
                    buyBoxSeller: firstProduct.buyBoxSeller,
                    lowest3PPrice: firstProduct.lowest3PPrice,
                    sellers: firstProduct.sellers,
                    brand: firstProduct.brand,
                    rating: firstProduct.rating,
                    reviewCount: firstProduct.reviewCount,
                    hasInventoryWarning,
                    hasWinningStore,
                    storeProducts: storeProducts.sort((a, b) => a.store.localeCompare(b.store)),
                    lastChecked,
                });
            }

            // Sort groups by total 14-day sales and limit
            productGroups.sort((a, b) => b.totalSales14Day - a.totalSales14Day);
            const limitedGroups = productGroups.slice(0, parseInt(limit));

            // Calculate summary for grouped view
            const allProductsInGroups = limitedGroups.flatMap(g => g.storeProducts);
            const published = allProductsInGroups.filter(p => p.publishedStatus === 'PUBLISHED').length;
            const unpublished = allProductsInGroups.filter(p => p.publishedStatus === 'UNPUBLISHED').length;
            const zeroInventory = allProductsInGroups.filter(p => p.inventoryWarning).length;

            const summary = {
                totalGroups: limitedGroups.length,
                totalProducts: allProductsInGroups.length,
                published,
                unpublished,
                unknown: allProductsInGroups.length - published - unpublished,
                zeroInventory,
                totalSales7Day: limitedGroups.reduce((sum, g) => sum + g.totalSales7Day, 0),
                totalSales14Day: limitedGroups.reduce((sum, g) => sum + g.totalSales14Day, 0),
                totalSales3Day: limitedGroups.reduce((sum, g) => sum + g.totalSales3Day, 0),
                lastDataUpdate: lastDataUpdate ? lastDataUpdate.toISOString() : null,
                dataSource: 'cached',
                refreshInterval: '6 hours',
            };

            return res.status(200).json({
                success: true,
                grouped: true,
                summary,
                productGroups: limitedGroups,
            });
        }

        // Non-grouped mode
        const limitedProducts = products.slice(0, parseInt(limit));

        // Calculate summary stats
        const published = limitedProducts.filter(p => p.publishedStatus === 'PUBLISHED').length;
        const unpublished = limitedProducts.filter(p => p.publishedStatus === 'UNPUBLISHED').length;
        const zeroInventory = limitedProducts.filter(p => p.inventoryWarning).length;

        const summary = {
            totalProducts: limitedProducts.length,
            published,
            unpublished,
            unknown: limitedProducts.length - published - unpublished,
            zeroInventory,
            totalSales7Day: limitedProducts.reduce((sum, p) => sum + (p.sales7Day || 0), 0),
            totalSales14Day: limitedProducts.reduce((sum, p) => sum + (p.sales14Day || 0), 0),
            totalSales3Day: limitedProducts.reduce((sum, p) => sum + (p.sales3Day || 0), 0),
            lastDataUpdate: lastDataUpdate ? lastDataUpdate.toISOString() : null,
            dataSource: 'cached',
            refreshInterval: '6 hours',
        };

        return res.status(200).json({
            success: true,
            grouped: false,
            summary,
            products: limitedProducts,
        });

    } catch (error) {
        console.error('Daily check-up real-time API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
