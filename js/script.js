
const dbName = "ESP8266DB";
const storeName = "IPStore";

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName, { keyPath: "id" });
            }
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

function getIPFromDB(db) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.get("ip");

        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = () => reject(request.error);
    });
}

function saveIPToDB(db, ip) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const request = store.put({ id: "ip", value: ip });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Thực hiện GET request
async function fetchJSON(url, protocol = "http") {
    return await reqGET(url, protocol).then(responseText => {
        try {
            return JSON.parse(responseText); // Parse JSON từ responseText
        } catch (error) {
            throw new Error("Failed to parse JSON: " + error.message);
        }
    });
}

async function reqGET(url, protocol = "http") {
    return req(url, protocol, "GET").then(responseText => { return responseText; });
}

function req(url, protocol = "http", med = "GET") {
    return new Promise((resolve, reject) => {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = `${protocol}://${url}`;
        }

        const xhr = new XMLHttpRequest();
        xhr.open(med, url, true);

        xhr.onreadystatechange = function () {
            if (xhr.readyState == 4) {
                if (xhr.status == 200) {
                    resolve(xhr.responseText); // Trả về text từ response
                } else {
                    reject(new Error(`HTTP error! status: ${xhr.status}`));
                }
            }
        };

        xhr.onerror = function () {
            reject(new Error("Network error"));
        };

        xhr.send();
    });
}

// Xây dựng các nút từ dữ liệu JSON
function buildButtons(data, ip) {
    const container = document.getElementById("buttons-container");

    let listBut = "";
    Object.keys(data).forEach((key) => {
        listBut += `<h4>PC #${+(data[key].idx) + 1} - GPIO ${data[key].GPIO}</h4><button id="${data[key].idx}" class="${data[key].stat}">`;
    });
    container.innerHTML = listBut;

    container.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", async (id) => {
            await reqGET(`${ip}/pw?relay=${id}`);
            setTimeout(() => getStat(ip), 1000);
        }, button.id);
    });
    
}

// Tải và hiển thị các nút
async function getStat(ip) {
    try {
        const data = await fetchJSON(`${ip}/stt`);
        buildButtons(data, ip);
    } catch (error) {
        console.error("Error fetching data:", error);
    }
}

// Khởi chạy ứng dụng
(async function () {
    const db = await initDB();
    let ip = await getIPFromDB(db);

    const ipInput = document.getElementById("ipserver");
    if (ip) {
        ipInput.value = ip;
        getStat(ip);
    }

    ipInput.addEventListener("change", async () => {
        ip = ipInput.value;
        await saveIPToDB(db, ip);
        getStat(ip);
    });

    document.getElementById("saveip").addEventListener("click", async () => {
        const ipInput = document.getElementById("ipserver");
        const ip = ipInput.value.trim();
    
        if (!ip) {
            alert("Please enter a valid IP address.");
            return;
        }
    
        try {
            const db = await initDB();
            await saveIPToDB(db, ip); // Lưu IP vào IndexedDB
            getStat(ip); // Thực hiện GET tới '/stt' và xây dựng các nút
        } catch (error) {
            console.error("Error fetching status or saving IP:", error);
        }
    });

})();