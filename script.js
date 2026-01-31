// --- 1. CONFIG & UTILS (Placed at top to prevent 'not defined' errors) ---
    const firebaseConfig = {
        apiKey: "AIzaSyAsCKNyHipM5kUKKqJ_klJ1J1l20E4iQ-k",
        authDomain: "saeyespecialists-portal.firebaseapp.com",
        projectId: "saeyespecialists-portal",
        storageBucket: "saeyespecialists-portal.firebasestorage.app",
        messagingSenderId: "584706843504",
        appId: "1:584706843504:web:9b7e3e5307f162de55e5b5"
    };
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();
    
    let allRecords = [];
    let reportCache = {};
    let doctorSettingsMap = {};
    let charts = {};
    let currentEditingDoc = "";
    const DOCTOR_COLORS = ['#0056b3', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6610f2', '#fd7e14', '#20c997', '#e83e8c', '#6f42c1'];

    // --- MODAL CONTROLLERS ---
    let pendingDeleteId = null; // Store ID to delete temporarily

    function closeModal() {
        document.getElementById('customModal').style.display = 'none';
    }

    function showCustomAlert(title, message) {
        document.getElementById('modalTitle').innerText = title;
        document.getElementById('modalMsg').innerText = message;
        document.getElementById('modalActions').innerHTML = 
            `<button class="btn btn-primary" onclick="closeModal()" style="min-width: 80px;">OK</button>`;
        document.getElementById('customModal').style.display = 'flex';
    }

    function askDeleteConfirmation(id) {
        pendingDeleteId = id;
        document.getElementById('modalTitle').innerText = "Confirm Deletion";
        document.getElementById('modalMsg').innerText = "Are you sure you want to permanently delete this record? This cannot be undone.";
        document.getElementById('modalActions').innerHTML = 
            `<button class="btn" style="background:#e9ecef; color:#495057;" onclick="closeModal()">Cancel</button>
             <button class="btn btn-danger" onclick="confirmDeleteAction()">Yes, Delete</button>`;
        document.getElementById('customModal').style.display = 'flex';
    }

    async function confirmDeleteAction() {
    if(!pendingDeleteId) return;
    closeModal();
    try {
        await db.collection("daily_reports").doc(pendingDeleteId).delete();
        
        const activeFY = document.getElementById('fyDropdown').value;
        
        // DELETE FROM RAM so we are forced to re-fetch fresh data
        delete reportCache[activeFY];
        
        // Reload
        loadScopedData(activeFY, true);
    } catch(e) {
        showCustomAlert("Error", "Could not delete: " + e.message);
    }
    pendingDeleteId = null;
}
    
    const formatCurr = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
    const parseDate = (str) => { 
        if(!str) return new Date(0); 
        const [d,m,y] = str.split('/'); 
        return new Date(`${y}-${m}-${d}`); 
    };
    const getFinancialYear = (d) => {
        const y = d.getFullYear(); const m = d.getMonth();
        const startY = m >= 6 ? y : y - 1;
        return `FY${startY.toString().substr(2)}/${(startY + 1).toString().substr(2)}`;
    };

    // Helper: Populates Month Dropdown
    function populateMonthDropdown() {
        const selectedFY = document.getElementById('dataFyFilter').value;
        const sel = document.getElementById('monthFilter');
        let relevantRecords = allRecords;
        if (selectedFY && selectedFY !== "No Data") {
            relevantRecords = allRecords.filter(r => getFinancialYear(r.jsDate) === selectedFY);
        }
        const months = [...new Set(relevantRecords.map(r => r.jsDate.toLocaleString('default', { month: 'short', year: 'numeric' })))];
        months.sort((a,b) => new Date(b) - new Date(a));
        sel.innerHTML = '<option value="">-- All Months --</option>';
        months.forEach(m => sel.innerHTML += `<option value="${m}">${m}</option>`);
    }

    // Helper: Populates Doctor Dropdown automatically
    function populateDoctorFilterDropdown() {
        const sel = document.getElementById('doctorFilter');
        const currentVal = sel.value; // Remember selection if refreshing
        
        // Get unique doctor names from the loaded records
        const doctors = [...new Set(allRecords.map(r => r.doctorName))].sort();
        
        sel.innerHTML = '<option value="">-- All Doctors --</option>';
        doctors.forEach(d => {
            sel.innerHTML += `<option value="${d}">${d}</option>`;
        });
        
        // Restore selection if it still exists
        if(doctors.includes(currentVal)) sel.value = currentVal;
    }
    
    // --- 2. AUTH ---
    const loginFunc = () => auth.signInWithEmailAndPassword(document.getElementById('email').value, document.getElementById('password').value).catch(e => showCustomAlert("Login Failed", e.message));
    document.getElementById('loginBtn').onclick = loginFunc;
    document.getElementById('password').addEventListener("keypress", (e) => { if(e.key === "Enter") loginFunc(); });
    window.logout = () => auth.signOut().then(() => location.reload());

    auth.onAuthStateChanged(user => {
    if (user) {
        document.getElementById('loginSection').classList.add('hidden');
        document.getElementById('appSection').classList.remove('hidden');
        const currentFY = getFinancialYear(new Date());
        loadScopedData(currentFY);
        logUserLogin(user.email);
        }
    });
    
    // --- 3. DATA LOADER (RAM CACHING STRATEGY) ---
async function loadScopedData(targetFY, forceRefresh = false) {
    document.getElementById('dbStatus').innerText = `Status: Loading ${targetFY}...`;
    if(!forceRefresh) renderSkeletonLoader();
    
    const startYear = "20" + targetFY.substring(2, 4); 
    const startDate = `${startYear}-07-01`;
    const endDate = `${parseInt(startYear)+1}-06-30`;

    try {
        // 1. Fetch Settings (Always fetch to ensure rates are current)
        const sSnap = await db.collection("doctor_settings").get();
        doctorSettingsMap = {}; 
        let dynamicYears = [];
        sSnap.forEach(d => {
            if(d.id === "meta_years") {
                dynamicYears = d.data().list || [];
            } else {
                doctorSettingsMap[d.id] = d.data();
            }
        });

        initFYDropdowns(targetFY, dynamicYears); 

        if (dynamicYears.length === 0) {
            document.getElementById('dbStatus').innerText = `Status: Ready (No Data)`;
            return; 
        }

        // 2. RAM CACHE CHECK
        // If we have it in memory AND we are not forcing a refresh -> Use RAM
        if (reportCache[targetFY] && !forceRefresh) {
            console.log(`⚡ Loaded ${targetFY} from RAM Cache (0 Reads)`);
            allRecords = reportCache[targetFY];
        } else {
            // Otherwise -> Go to Network
            console.log(`☁️ Fetching ${targetFY} from Firebase...`);
            const rSnap = await db.collection("daily_reports")
                .where('dateISO', '>=', startDate)
                .where('dateISO', '<=', endDate)
                .get();

            allRecords = []; 
            rSnap.forEach(d => { 
                let r=d.data(); 
                r.id=d.id; 
                r.jsDate=parseDate(r.reportDate); 
                allRecords.push(r); 
            });

            // SAVE TO RAM
            reportCache[targetFY] = allRecords;
        }

        // 3. Re-process dates (Just to be safe)
        allRecords.forEach(r => {
             if (typeof r.jsDate === 'string') r.jsDate = new Date(r.jsDate);
             if (!r.jsDate || isNaN(r.jsDate)) r.jsDate = parseDate(r.reportDate);
        });

        document.getElementById('dbStatus').innerText = `Status: Online | ${allRecords.length} Records (${targetFY})`;
        
        populateMonthDropdown();
        populateDoctorFilterDropdown();           
        renderVisuals();
        renderDoctorList();
        
        if (document.getElementById('tab-data').classList.contains('active')) {
            runFilterLogic();
        }
        
    } catch (e) { 
        document.getElementById('dbStatus').innerText = "Error: " + e.message; 
        console.error(e);
    }
}

    function initFYDropdowns(activeFY, availableYears = []) {
        const selDash = document.getElementById('fyDropdown'); 
        const selData = document.getElementById('dataFyFilter');
        
        // Strict Logic: If no years in DB, show "No Data"
        if (availableYears.length === 0) {
            selDash.innerHTML = "<option>No Data</option>";
            selData.innerHTML = "<option>No Data</option>";
            return;
        }

        let fyList = availableYears.sort().reverse();
        if(!fyList.includes(activeFY) && activeFY !== "No Data") fyList.unshift(activeFY);
        fyList = [...new Set(fyList)];

        selDash.innerHTML = "";
        selData.innerHTML = ""; 

        fyList.forEach(fy => {
            selDash.innerHTML += `<option value="${fy}">${fy}</option>`;
            selData.innerHTML += `<option value="${fy}">${fy}</option>`;
        });

        selDash.value = activeFY;
        selData.value = activeFY;

        selDash.onchange = () => {
            selData.value = selDash.value;
            loadScopedData(selDash.value);
        };
        selData.onchange = () => {
            selDash.value = selData.value;
            loadScopedData(selData.value);
        };
    }

    // --- 4. EXCEL UPLOAD ---
    const EXCEL_COLS = [
        "Amount Billed", "Cash Received", "EFTPOS Received", "Credit Card Received", 
        "Extras Cover Received", "Bank Transfer Received", "Cheque Received", 
        "Deposit Applied", "Bulk Bill Received", "DVA Received", "ECLIPSE Received", 
        "90 Day Gap Received", "Amount Received"
    ];

    document.getElementById('excelFile').onchange = function() {
        const status = document.getElementById('uploadStatus');
        status.style.color = "blue";
        status.innerText = "Processing...";
        const reader = new FileReader();
        
        reader.onload = async function(e) {
            try {
                const wb = XLSX.read(new Uint8Array(e.target.result), {type: 'array'});
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
                
                let date = "", hIdx = -1;
                for(let i=0; i<Math.min(rows.length, 25); i++){
                    const txt = (rows[i]||[]).join(" ");
                    if(txt.includes("Period")){ const m = txt.match(/\d{1,2}\/\d{1,2}\/\d{4}/g); if(m) date=m[0]; }
                    if((rows[i]||[]).includes("Doctor")) hIdx=i;
                }

                if(!date) throw new Error("Could not find 'Period:' date in file.");

                const [d, m, y] = date.split('/');
                const dateISO = `${y}-${m}-${d}`;
                const fileDate = new Date(`${y}-${m}-${d}`);
                const fileFY = getFinancialYear(fileDate);

                const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { range: hIdx });
                const batch = db.batch();
                let count = 0;

                for(const r of json){
                    const keys = Object.keys(r);
                    const findKey = (name) => keys.find(k => k.trim().toLowerCase() === name.toLowerCase());
                    const doc = (r[findKey('Doctor')]||"").toString().trim();
                    
                    if(doc && !doc.includes("Total:")){
                        const loc = r[findKey('Location')]||"N/A";
                        const id = `${date}_${doc}_${loc}`.replace(/\//g,'-').replace(/\s+/g,'_');
                        
                        let dataObj = {
                            reportDate: date,
                            dateISO: dateISO,
                            doctorName: doc,
                            location: loc,
                            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                        };

                        EXCEL_COLS.forEach(colName => {
                            const val = r[findKey(colName)];
                            dataObj[colName.replace(/\s+/g, '')] = parseFloat(val) || 0; 
                        });

                        batch.set(db.collection("daily_reports").doc(id), dataObj, {merge:true});
                        count++;
                    }
                }
                
                const metaRef = db.collection("doctor_settings").doc("meta_years");
                batch.set(metaRef, { 
                    list: firebase.firestore.FieldValue.arrayUnion(fileFY) 
                }, { merge: true });

                await batch.commit();
                status.style.color = "green";
                status.innerText = `✔ Saved ${count} records (${fileFY})`;
                
                // DELETE FROM RAM
                delete reportCache[fileFY];

                // Reload
                setTimeout(() => loadScopedData(fileFY, true), 1000);
                
            } catch(e) {
                status.style.color = "red";
                status.innerText = "Error: " + e.message;
                console.error(e);
            }
        };
        reader.readAsArrayBuffer(this.files[0]);
    };

    // --- VISUAL HELPERS ---
    function renderSkeletonLoader() {
        const tbody = document.getElementById('recordsTableBody');
        let html = '';
        // Create 10 fake rows
        for(let i=0; i<10; i++) {
            html += `
                <tr>
                    <td><span class="skeleton" style="width: 80px;"></span></td>
                    <td><span class="skeleton" style="width: 120px;"></span></td>
                    <td><span class="skeleton" style="width: 100px;"></span></td>
                    <td><span class="skeleton" style="width: 80px;"></span></td>
                    <td><span class="skeleton" style="width: 40px;"></span></td>
                    <td><span class="skeleton" style="width: 80px;"></span></td>
                    <td><span class="skeleton" style="width: 60px;"></span></td>
                    <td><span class="skeleton" style="width: 60px;"></span></td>
                    <td></td>
                </tr>`;
        }
        tbody.innerHTML = html;
        // Reset totals to "..." while loading
        ['totalReceived', 'totalFee', 'totalGST', 'totalRemit'].forEach(id => {
            document.getElementById(id).innerText = "...";
        });
    }
    
    // --- 5. UI & LOGIC ---
    window.generatePDF = function() {
        const docName = document.getElementById('doctorFilter').value;
        const monthFilter = document.getElementById('monthFilter').value;
        const fyFilter = document.getElementById('dataFyFilter').value;
        
        // 1. Validation: Ensure a doctor is selected
        if(!docName) { 
            showCustomAlert("Action Required", "Please filter by a specific Doctor first using the 'Search Doctor' box."); 
            return; 
        }
        
        // 2. Filter data for the PDF
        const pdfData = allRecords.filter(r => {
            const matchFY = !fyFilter || getFinancialYear(r.jsDate) === fyFilter;
            const matchM = !monthFilter || r.jsDate.toLocaleString('default', { month: 'short', year: 'numeric' }) === monthFilter;
            const matchDoc = r.doctorName === docName;
            return matchFY && matchM && matchDoc;
        });

        if(pdfData.length === 0) {
            showCustomAlert("No Data", "No records found for this doctor in the selected period.");
            return;
        }

        // 3. Calculate Totals
        const cashKey = "CashReceived";
        const tyroKeys = [
            "EFTPOSReceived", "CreditCardReceived", "ExtrasCoverReceived", 
            "BankTransferReceived", "ChequeReceived", "DepositApplied", 
            "BulkBillReceived", "DVAReceived", "ECLIPSEReceived", "90DayGapReceived"
        ];
        
        let totalTyro = 0; let totalCash = 0; let totalCommission = 0; let breakdown = {};
        [cashKey, ...tyroKeys].forEach(k => breakdown[k] = 0);

        pdfData.forEach(r => {
            const cVal = r[cashKey] || 0;
            totalCash += cVal; breakdown[cashKey] += cVal;
            let rTyro = 0;
            tyroKeys.forEach(k => {
                const val = r[k] || 0;
                rTyro += val; breakdown[k] += val;
            });
            totalTyro += rTyro;
            const totalBillingsForRecord = cVal + rTyro;
            const {rate} = getRate(r.doctorName, r.jsDate);
            totalCommission += totalBillingsForRecord * (rate / 100);
        });

        const totalGST = totalCommission * 0.10;
        const totalPayableToSAES = totalCommission + totalGST;
        const finalBalance = totalPayableToSAES - totalCash;
        const totalBillings = totalTyro + totalCash;

        // 4. Generate PDF
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        // Add Logo
        const logoImg = document.getElementById('pdfLogoSource');
        if (logoImg.complete && logoImg.naturalHeight !== 0) {
            doc.addImage(logoImg, 'PNG', 15, 10, 40, 15);
        }
        
        // Header
        doc.setFontSize(16); doc.text("TAX INVOICE", 195, 20, { align: "right" });
        doc.setFontSize(10); doc.setTextColor(100);
        const reportPeriod = monthFilter ? monthFilter : (fyFilter || "All Time");
        doc.text(`Period: ${reportPeriod}`, 195, 27, { align: "right" });
        doc.text(`Date: ${new Date().toLocaleDateString()}`, 195, 32, { align: "right" });

        doc.setTextColor(0); doc.setFont(undefined, 'bold');
        doc.text("Pay to: SA Eye Specialists", 195, 42, { align: "right" });
        doc.setFont(undefined, 'normal');
        doc.text("BSB: 065 137", 195, 47, { align: "right" });
        doc.text("Account: 1105 9977", 195, 52, { align: "right" });

        doc.setFontSize(12); doc.setTextColor(0); doc.text(`To: ${docName}`, 15, 40);
        
        // Summary Box
        doc.setFillColor(245, 245, 245); doc.rect(15, 60, 180, 30, 'F');
        doc.setFontSize(10);
        doc.text("Total Billings:", 20, 70);       doc.text(formatCurr(totalBillings), 65, 70, { align: "right" });
        doc.text("Practice Revenue:", 20, 78);    doc.text(formatCurr(totalCommission), 65, 78, { align: "right" });
        doc.text("Cash at SAES:", 100, 70);          doc.text(formatCurr(totalCash), 160, 70, { align: "right" });
        doc.setFont(undefined, 'bold');
        doc.text("Balance Payable:", 100, 78);   doc.text(formatCurr(finalBalance), 160, 78, { align: "right" });
        doc.setFont(undefined, 'normal');

        // Detailed Table
        doc.autoTable({
            html: '#dataTableElement', startY: 95, theme: 'striped', headStyles: { fillColor: [0, 86, 179] },
            columns: [ { header: 'Date', dataKey: 0 }, { header: 'Location', dataKey: 2 }, { header: 'Billings', dataKey: 3 }, { header: 'Prac Rev', dataKey: 5 }, { header: 'GST', dataKey: 6 }, { header: 'Remit', dataKey: 7 } ],
            didParseCell: function(data) { if (data.column.index === 1 || data.column.index === 4 || data.column.index === 8) data.cell.styles.display = 'none'; }
        });

        let finalY = doc.lastAutoTable.finalY + 15;
        if (finalY > 200) { doc.addPage(); finalY = 20; }

        // Breakdown Table
        doc.setFontSize(11); doc.setTextColor(0); doc.setFont(undefined, 'bold');
        doc.text("Payment Breakdown & Tax Invoice Calculation", 15, finalY);
        doc.setLineWidth(0.5); doc.line(15, finalY + 2, 95, finalY + 2);

        let tableBody = [];
        tyroKeys.forEach(key => {
            if(breakdown[key] > 0) {
                const label = key.replace(/([A-Z])/g, ' $1').replace('Received','').trim(); 
                tableBody.push([label, formatCurr(breakdown[key]), "-"]);
            }
        });
        tableBody.push(["Cash", "-", formatCurr(totalCash)]);
        tableBody.push([{ content: "Total Receipts", styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, { content: formatCurr(totalTyro), styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }, { content: formatCurr(totalCash), styles: { fontStyle: 'bold', fillColor: [240, 240, 240] } }]);
        const addSummaryRow = (label, value, isBold = false) => { tableBody.push([{ content: label, colSpan: 2, styles: { halign: 'right', fontStyle: isBold ? 'bold' : 'normal' } }, { content: formatCurr(value), styles: { fontStyle: isBold ? 'bold' : 'normal' } }]); };
        tableBody.push([{ content: "", colSpan: 3, styles: { cellPadding: 1, fillColor: [255, 255, 255] } }]); 
        addSummaryRow(`Practice Commission`, totalCommission);
        addSummaryRow("GST (10%)", totalGST);
        tableBody.push([{ content: "Total Payable to SAES", colSpan: 2, styles: { halign: 'right', fontStyle: 'bold', fillColor: [231, 241, 255] } }, { content: formatCurr(totalPayableToSAES), styles: { fontStyle: 'bold', fillColor: [231, 241, 255], textColor: [0, 86, 179] } }]);
        addSummaryRow("Less: Cash already received at SAES", -totalCash);
        tableBody.push([{ content: `Balance Payable to SAES (${reportPeriod})`, colSpan: 2, styles: { halign: 'right', fontStyle: 'bold', fontSize: 11, fillColor: [0, 86, 179], textColor: [255, 255, 255] } }, { content: formatCurr(finalBalance), styles: { fontStyle: 'bold', fontSize: 11, fillColor: [0, 86, 179], textColor: [255, 255, 255] } }]);

        doc.autoTable({ startY: finalY + 5, head: [['Description', 'Received in Tyro', 'Cash at SAES']], body: tableBody, theme: 'grid', headStyles: { fillColor: [0, 86, 179] }, columnStyles: { 0: { cellWidth: 80 }, 1: { halign: 'right', font: 'courier' }, 2: { halign: 'right', font: 'courier' } } });
        
        // --- FIX WAS HERE: Define fileName before saving ---
        const cleanDocName = docName.replace(/[^a-zA-Z0-9]/g, '_');
        const cleanPeriod = reportPeriod.replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `Invoice_${cleanDocName}_${cleanPeriod}.pdf`;

        doc.save(fileName);
    };

    function renderVisuals() {
        const selectedFY = document.getElementById('fyDropdown').value;
        if(!allRecords.length || selectedFY === "No Data") return;
        
        const fyRecords = allRecords.filter(r => getFinancialYear(r.jsDate) === selectedFY);

        let totalBillings = 0; let totalPracticeRev = 0;
        const billByDoc = {}; const pracByDoc = {}; const billTrends = {}; const pracTrends = {};

        fyRecords.forEach(r => {
            const valReceived = r.AmountReceived || 0; 
            const {rate} = getRate(r.doctorName, r.jsDate);
            const fee = valReceived * (rate / 100);

            totalBillings += valReceived;
            totalPracticeRev += fee;

            billByDoc[r.doctorName] = (billByDoc[r.doctorName] || 0) + valReceived;
            pracByDoc[r.doctorName] = (pracByDoc[r.doctorName] || 0) + fee;

            if(!billTrends[r.doctorName]) billTrends[r.doctorName] = Array(12).fill(0);
            if(!pracTrends[r.doctorName]) pracTrends[r.doctorName] = Array(12).fill(0);
            const mIndex = r.jsDate.getMonth(); 
            let fyIndex = (mIndex + 6) % 12; 
            billTrends[r.doctorName][fyIndex] += valReceived;
            pracTrends[r.doctorName][fyIndex] += fee;
        });

        document.getElementById('dashTotalRev').innerText = formatCurr(totalBillings);
        document.getElementById('dashPracRev').innerText = formatCurr(totalPracticeRev);
        
        const docNames = Object.keys(billByDoc);
        const monthKeys = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];

        const getBarDataset = (dataObj) => docNames.map((name, i) => ({ label: name, data: [dataObj[name]], backgroundColor: DOCTOR_COLORS[i % DOCTOR_COLORS.length] }));
        const getLineDataset = (dataObj) => Object.keys(dataObj).map((docName, i) => {
            const docIndex = docNames.indexOf(docName);
            const color = (docIndex !== -1) ? DOCTOR_COLORS[docIndex % DOCTOR_COLORS.length] : '#000';
            return { label: docName, data: dataObj[docName], borderColor: color, backgroundColor: 'transparent', tension: 0.1 };
        });

        createChart('chartBillBar', 'bar', ['Billings'], getBarDataset(billByDoc), 'bar');
        createChart('chartPracBar', 'bar', ['Revenue'], getBarDataset(pracByDoc), 'bar');
        createChart('chartBillLine', 'line', monthKeys, getLineDataset(billTrends), 'line');
        createChart('chartPracLine', 'line', monthKeys, getLineDataset(pracTrends), 'line');
    }

    function createChart(canvasId, type, labels, datasets, mode) {
        const ctx = document.getElementById(canvasId).getContext('2d');
        if(charts[canvasId]) charts[canvasId].destroy();
        charts[canvasId] = new Chart(ctx, {
            type: type, data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: true, position: 'top' } },
                scales: mode === 'bar' ? { x: { ticks: { display: false } } } : {},
                onClick: (e, activeEls) => {
                    if (activeEls.length > 0) {
                        const dsIndex = activeEls[0].datasetIndex;
                        const index = activeEls[0].index;
                        const activeFY = document.getElementById('fyDropdown').value;
                        switchTab('data'); document.getElementById('dataFyFilter').value = activeFY;
                        
                        if (mode === 'bar') { document.getElementById('doctorFilter').value = datasets[dsIndex].label; } 
                        else if (mode === 'line') {
                            const docName = datasets[dsIndex].label; const monthShort = labels[index];
                            const years = activeFY.replace("FY","").split("/");
                            const year = (index <= 5) ? "20"+years[0] : "20"+years[1];
                            document.getElementById('doctorFilter').value = docName;
                            populateMonthDropdown();
                            document.getElementById('monthFilter').value = `${monthShort} ${year}`;
                        }
                        runFilterLogic();
                    }
                }
            }
        });
    }

    window.goToDataTabWithFY = function() {
        const activeFY = document.getElementById('fyDropdown').value;
        if(activeFY && activeFY !== "No Data") {
            switchTab('data'); document.getElementById('dataFyFilter').value = activeFY;
            populateMonthDropdown(); runFilterLogic();
        }
    };

    // --- FILTERING LOGIC ---
    function runFilterLogic() {
        const fy = document.getElementById('dataFyFilter').value;
        const m = document.getElementById('monthFilter').value;
        const doc = document.getElementById('doctorFilter').value; 
        
        // Safety check: If allRecords is empty, stop.
        if(!allRecords) return; 

        const filtered = allRecords.filter(r => {
            const matchFY = !fy || getFinancialYear(r.jsDate) === fy;
            const matchM = !m || r.jsDate.toLocaleString('default', { month: 'short', year: 'numeric' }) === m;
            const matchDoc = !doc || r.doctorName === doc;
            return matchFY && matchM && matchDoc;
        });
        renderDashboard(filtered);
    }

    // Event Listeners: Trigger filter instantly on change
    document.getElementById('doctorFilter').addEventListener('change', runFilterLogic);
    document.getElementById('monthFilter').addEventListener('change', runFilterLogic);
    document.getElementById('dataFyFilter').addEventListener('change', runFilterLogic);

    document.getElementById('clearFilters').onclick = () => {
        document.getElementById('dataFyFilter').value = document.getElementById('fyDropdown').value; 
        populateMonthDropdown();
        populateDoctorFilterDropdown();
        document.getElementById('monthFilter').value = ""; 
        document.getElementById('doctorFilter').value = "";
        runFilterLogic();
    };
    
    function renderDashboard(data) {
        const tbody = document.getElementById('recordsTableBody');
        // Clear table if no data
        if(!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px;">No records found.</td></tr>';
            ['totalReceived', 'totalFee', 'totalGST', 'totalRemit'].forEach(id => document.getElementById(id).innerText = '$0.00');
            return;
        }

        let tRec=0, tFee=0, tGST=0, tRem=0;
        
        const rowsHTML = data.sort((a,b) => b.jsDate - a.jsDate).map(d => {
            const valReceived = d.AmountReceived || 0; 
            const {rate, isEx} = getRate(d.doctorName, d.jsDate);
            const fee = valReceived * (rate / 100); 
            const gst = fee * 0.10; 
            const remit = valReceived - (fee + gst);
            tRec += valReceived; tFee += fee; tGST += gst; tRem += remit;
            
            const badge = isEx ? 
                `<span style="background:#fff3cd; color:#856404; padding:2px 6px; border-radius:4px; font-size:11px;">${rate}% (Ex)</span>` : 
                `<span style="background:#e7f1ff; color:#0056b3; padding:2px 6px; border-radius:4px; font-size:11px;">${rate}%</span>`;
            
            return `<tr>
                <td>${d.reportDate}</td>
                <td style="font-weight:600;">${d.doctorName}</td>
                <td>${d.location}</td>
                <td class="money-col">${formatCurr(valReceived)}</td>
                <td style="text-align:center;">${badge}</td>
                <td class="money-col">${formatCurr(fee)}</td>
                <td class="money-col">${formatCurr(gst)}</td>
                <td class="money-col" style="color:#28a745;">${formatCurr(remit)}</td>
                <td style="text-align:center;"><button class="btn btn-danger" style="font-size:10px;" onclick="askDeleteConfirmation('${d.id}')">Del</button></td>
            </tr>`;
        }).join('');

        tbody.innerHTML = rowsHTML;
        document.getElementById('totalReceived').innerText = formatCurr(tRec); 
        document.getElementById('totalFee').innerText = formatCurr(tFee);
        document.getElementById('totalGST').innerText = formatCurr(tGST); 
        document.getElementById('totalRemit').innerText = formatCurr(tRem);
    }
    
    function getRate(docName, jsDate) {
        const set = doctorSettingsMap[docName]; if(!set) return { rate: 0, isEx: false };
        const mStr = jsDate.toLocaleString('default', { month: 'short', year: 'numeric' });
        if(set.exceptions && set.exceptions[mStr] !== undefined) return { rate: parseFloat(set.exceptions[mStr]), isEx: true };
        if(set.timeline && set.timeline.length > 0) {
            const sorted = [...set.timeline].sort((a,b) => new Date(b.startDate) - new Date(a.startDate));
            const rule = sorted.find(r => new Date(r.startDate) <= jsDate); if(rule) return { rate: parseFloat(rule.fee), isEx: false };
        }
        return { rate: 0, isEx: false };
    }
    window.switchTab = (tab) => {
        // 1. Hide all tabs, deactivate all buttons
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active')); 
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        
        // 2. Show the specific tab requested
        document.getElementById(`tab-${tab}`).classList.add('active');
        
        // 3. Highlight the correct header button
        let btnId = 'tabBtnVisuals'; // Default
        if(tab === 'data') btnId = 'tabBtnData'; 
        if(tab === 'settings') btnId = 'tabBtnSet';
        if(tab === 'analysis') btnId = 'tabBtnAnalysis'; 
        
        const btn = document.getElementById(btnId);
        if(btn) btn.classList.add('active'); // Safety check added
        
        // 4. Run Tab Specific Logic
        if (tab === 'data') {
            const activeFY = document.getElementById('fyDropdown').value;
            if(document.getElementById('dataFyFilter')) {
                document.getElementById('dataFyFilter').value = activeFY;
                if(typeof runFilterLogic === 'function') runFilterLogic(); 
            }
        }
        
        if (tab === 'analysis') {
            // Only init table if it hasn't been drawn yet, or just to refresh data
            initPivotTable(); 
            // We ONLY load the list here, when entering the tab
            loadSavedReportsList(); 
        }
    };
    
    function renderDoctorList() {
        const doctors = [...new Set(allRecords.map(r => r.doctorName))].sort();
        const panel = document.getElementById('doctorListPanel'); panel.innerHTML = "";
        doctors.forEach(name => {
            if (name && name !== "meta_years") {
                const div = document.createElement('div'); div.className = "doctor-item"; div.innerText = name;
                div.onclick = () => { document.querySelectorAll('.doctor-item').forEach(i => i.classList.remove('selected')); div.classList.add('selected'); openConfig(name); };
                panel.appendChild(div);
            }
        });
    }
    
    function openConfig(name) {
        currentEditingDoc = name;
        document.getElementById('noDocSelected').style.display = 'none';
        document.getElementById('configPanel').style.display = 'block';
        document.getElementById('configTitle').innerText = name;
        const set = doctorSettingsMap[name] || { timeline: [], exceptions: {}, bsb: "", acc: "" };
        document.getElementById('docBSB').value = set.bsb || "";
        document.getElementById('docAcc').value = set.acc || "";
        document.getElementById('timelineContainer').innerHTML = "";
        (set.timeline || []).forEach(r => addTimelineRow(r.startDate, r.fee));
        document.getElementById('exceptionsContainer').innerHTML = "";
        Object.entries(set.exceptions || {}).forEach(([m, f]) => addExceptionRow(m, f));
    }
    window.addTimelineRow = (d="", f="") => {
        const div = document.createElement('div'); div.className = "input-group";
        div.innerHTML = `<input type="date" class="tl-d" value="${d}"><input type="number" class="tl-f" value="${f}" style="width:60px;"><button class="btn btn-danger" onclick="this.parentElement.remove()">×</button>`;
        document.getElementById('timelineContainer').appendChild(div);
    };
    window.addExceptionRow = (m="", f="") => {
        const div = document.createElement('div'); div.className = "input-group";
        div.innerHTML = `<input type="text" class="ex-m" value="${m}" placeholder="Nov 2025"><input type="number" class="ex-f" value="${f}" style="width:60px;"><button class="btn btn-danger" onclick="this.parentElement.remove()">×</button>`;
        document.getElementById('exceptionsContainer').appendChild(div);
    };
    window.saveDoctorSettings = async () => {
        const tl = []; document.querySelectorAll('.tl-d').forEach((el, i) => { const f = document.querySelectorAll('.tl-f')[i].value; if(el.value && f) tl.push({ startDate: el.value, fee: f }); });
        const ex = {}; document.querySelectorAll('.ex-m').forEach((el, i) => { const f = document.querySelectorAll('.ex-f')[i].value; if(el.value && f) ex[el.value] = f; });
        const bsb = document.getElementById('docBSB').value; const acc = document.getElementById('docAcc').value;
        try {
            await db.collection("doctor_settings").doc(currentEditingDoc).set({ timeline: tl, exceptions: ex, bsb: bsb, acc: acc });
            document.getElementById('saveStatus').innerText = "Saved!";
            document.getElementById('saveStatus').style.color = "green";
            const activeFY = document.getElementById('fyDropdown').value; loadScopedData(activeFY);
        } catch (e) { document.getElementById('saveStatus').innerText = "Error: " + e.message; }
    };
    // --- PIVOT TABLE & REPORTING LOGIC ---
    
    // 1. Initialize the Table (with optional config)
    function initPivotTable(configToLoad = null) {
        // 1. Safety Check
        if(!allRecords || allRecords.length === 0) {
            // If the div exists, show a message
            const existingDiv = document.getElementById('pivotOutput');
            if(existingDiv) existingDiv.innerHTML = '<p>No data available to analyze.</p>';
            return;
        }

        // 2. THE NUCLEAR RESET: Destroy the old container completely
        // This removes all "sticky" connections from the library
        const parentTab = document.getElementById('tab-analysis');
        const oldDiv = document.getElementById('pivotOutput');
        if (oldDiv) oldDiv.remove();

        // 3. Create a fresh, clean container
        const newDiv = document.createElement('div');
        newDiv.id = 'pivotOutput';
        newDiv.style.overflowX = 'auto';
        newDiv.style.minHeight = '500px';
        newDiv.innerHTML = '<div style="padding:40px; text-align:center; color:#999;">Building Analysis...</div>';
        
        // Append it to the tab (it will go to the bottom, below the controls)
        parentTab.appendChild(newDiv);

        // 4. Prepare Data
        const pivotData = allRecords.map(r => {
            const {rate} = getRate(r.doctorName, r.jsDate);
            return {
                Date: r.reportDate,
                Month: r.jsDate.toLocaleString('default', { month: 'short', year: 'numeric' }),
                "Financial Year": getFinancialYear(r.jsDate),
                Doctor: r.doctorName,
                Location: r.location,
                "Total Billings": r.AmountReceived || 0,
                "Practice Revenue": (r.AmountReceived || 0) * (rate / 100),
                "Cash Received": r.CashReceived || 0,
                "EFTPOS Received": r.EFTPOSReceived || 0
            };
        });

        // 5. Set Config
        let options = {
            rows: ["Doctor"],
            cols: ["Month"],
            vals: ["Total Billings"],
            aggregatorName: "Sum",
            rendererName: "Table Heatmap",
            renderers: $.pivotUtilities.renderers
        };

        // Merge Saved Config if we have one
        if (configToLoad) {
            options = { ...options, ...configToLoad };
        }

        // 6. Draw the Table (with the 'overwrite' flag set to true)
        $("#pivotOutput").pivotUI(pivotData, options, true);
    }

    // 2. Save Logic
    async function saveCurrentReport() {
        const name = document.getElementById('newReportName').value.trim();
        if (!name) { showCustomAlert("Error", "Please enter a name for this report."); return; }

        // Get current config from the library
        const config = $("#pivotOutput").data("pivotUIOptions");
        
        // Extract ONLY what we need to save (we don't save the data itself, just the settings)
        const settingsToSave = {
            rows: config.rows,
            cols: config.cols,
            vals: config.vals,
            aggregatorName: config.aggregatorName,
            rendererName: config.rendererName,
            inclusions: config.inclusions, // Saves checkbox filters
            exclusions: config.exclusions  // Saves checkbox filters
        };

        try {
            await db.collection("saved_reports").doc(name).set(settingsToSave);
            document.getElementById('newReportName').value = ""; // Clear input
            showCustomAlert("Success", "Report saved successfully!");
            loadSavedReportsList(); // Refresh dropdown
        } catch (e) {
            showCustomAlert("Error", "Could not save: " + e.message);
        }
    }

    // 3. Load List Logic (Populates Dropdown)
    async function loadSavedReportsList() {
        const sel = document.getElementById('savedReportsDropdown');
        try {
            const snap = await db.collection("saved_reports").get();
            sel.innerHTML = '<option value="">-- Select a Report --</option>';
            snap.forEach(doc => {
                sel.innerHTML += `<option value="${doc.id}">${doc.id}</option>`;
            });
        } catch (e) {
            console.error("Error loading reports", e);
        }
    }

    // 4. Load Action (When user selects a report)
    async function loadSelectedReport() {
        const name = document.getElementById('savedReportsDropdown').value;
        if (!name) return;

        try {
            const doc = await db.collection("saved_reports").doc(name).get();
            if (doc.exists) {
                // Re-initialize table with these settings
                initPivotTable(doc.data());
            }
        } catch (e) {
            showCustomAlert("Error", "Could not load report: " + e.message);
        }
    }

    // 5. Delete Action
    async function deleteSelectedReport() {
        const name = document.getElementById('savedReportsDropdown').value;
        if (!name) { showCustomAlert("Error", "Please select a report to delete."); return; }

        if (confirm(`Are you sure you want to delete "${name}"?`)) {
            try {
                await db.collection("saved_reports").doc(name).delete();
                loadSavedReportsList();
                document.getElementById('savedReportsDropdown').value = "";
            } catch (e) {
                showCustomAlert("Error", "Could not delete: " + e.message);
            }
        }
    }

// --- 6. AUDIT LOGGING (ALWAYS RUNS) ---
async function logUserLogin(email) {
    // No "Session Check" - runs on every F5/Login
    try {
        const res = await fetch('https://ipwho.is/');
        const data = await res.json();
        
        await db.collection('audit_logs').add({
            email: email,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            action: 'ACCESS', // "Access" covers both Login and Refresh
            
            ip_address: data.ip || 'Unknown',
            isp: (data.connection && data.connection.isp) ? data.connection.isp : 'Unknown',
            
            city: data.city || 'Unknown',
            region: data.region || 'Unknown',
            country: data.country || 'Unknown',
            
            userAgent: navigator.userAgent 
        });
        console.log("Audit log saved.");

    } catch (e) {
        console.error("Could not save audit log:", e);
    }
}
