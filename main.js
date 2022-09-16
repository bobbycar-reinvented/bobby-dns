const dns2 = require('dns2');

require('dotenv').config();

const { Packet } = dns2;

const allowed_users = ["comred", "feedc0de", "peter", "mick", "greyhash", "relay", "seatbot", "relay_comred", "relay_realraum", "comred_new", "testdevice", "gabor"];

var ttl = {};
const zone_id = process.env.CLOUDFLARE_ZONE_ID;

const server = dns2.createServer({
    udp: true,
    handle: dnsHandle
});

const cloudflare = require('cloudflare');
const cf = new cloudflare({
    token: process.env.CLOUDFLARE_TOKEN
});


server.on('listening', () => {
    console.log('listening');
    let keys = Object.keys(server.addresses());

    for (let i = 0; i < keys.length; i++) {
        console.log(server.addresses()[keys[i]]);
    }
});

server.on('close', () => {
    console.log('server closed');
    process.exit();
});

delete_all();

server.listen({
    udp: {
        port: 53,
        address: process.env.DNS_SERVER_IP
    }
});

server.on('error', (err) => {
    console.log('server error', err);
});

function replaceAll(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
}

function extractIPFromDomain(domain) { // Example: '192.168.0.128.USERNAME.announce.bobbycar.cloud' or 'fe80::1252:1cff:fe82:39dc.USERNAME.announce6.bobbycar.cloud'
    domain = domain.toLowerCase();
    try {

        let ip, username, type;

        // Extract USERNAME
        let username_tmp = domain.split('.');
        username = username_tmp[username_tmp.length - 4];

        if (domain.includes('announce6')) { // address is ipv6; set type to 'AAAA'; parse ipv6 address
            type = 'AAAA';
            let splitted = domain.split("."+username);
            if (splitted.length <= 1) { // Filter incomplete requests
                return undefined;
            }
            ip = expandIPV6(splitted[0]);

        } else if (domain.includes('announce')) { // address is ipv4; set type to 'A'; parse ipv4 address
            type = 'A';
            let splitted = domain.split("."+username);
            if (splitted.length <= 1) { // Filter incomplete requests
                return undefined;
            }
            ip = splitted[0];

        } else return null;

        let extracted = {
            ip,
            username,
            type
        }

        return extracted;
    } catch (e) {
        console.log('error', e);
        return null;
    }
}

function get_current_timestamp() {
    return Math.floor(Date.now() / 1000);
}

function expandIPV6(ipv6) {// expand :: to 0000 and check for length
    if (typeof ipv6 === 'undefined' || ipv6 === null) {
        return null;
    }

    ipv6 = replaceAll(ipv6, '-', ':');

    const splitted = ipv6.split(':');
    const num_splitted = splitted.length - 1;
    const blocks = splitted.length;
    let expanded = '';

    if (blocks < 8) {
        solution = ipv6.split('::').join(Array(11 - blocks).join(':'));
    } else solution = ipv6;

    let a = solution.split(':');
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '') {
            a[i] = '0000';
        }
    }

    return a.join(':');
}

function createDNSEntryOnCloudflare(ip, username, type, is_global) { // ip can be ipv4 or ipv6 (expanded) and type can be A or AAAA; domain would be username.bobbycar.cloud
    if (typeof ip === 'undefined' || ip === null) {
        return null;
    }

    if (typeof username === 'undefined' || username === null) {
        return null;
    }

    if (typeof type === 'undefined' || type === null) {
        return null;
    }

    if ((ip.match(/./g) || []).length < 4) {
        return null;
    }

    let domain = username;
    domain += (type === "A") ? '.bobbycar.cloud': '.bobbycar.cloud';

    let domainsToAdd = [];
    domainsToAdd.push({
        type: type,
        name: is_global ? "global." + domain : domain,
        content: ip
    });

    if (type === 'AAAA' && !is_global) {
        ip = expandIPV6(ip);
        domainsToAdd.push({
            type: 'AAAA',
            name: 'ipv6.' + domain,
            content: ip
        });
    }

    cf.dnsRecords.browse(zone_id).
    then(function (response) {
        domainsToAdd.forEach((entry) => {
            let found = false;
            let id = null;
            const records = response.result;

            for (let i = 0; i < records.length; i++) {
                let record = records[i];
                if (record.name == entry.name && record.type == entry.type) {
                    found = true;
                    id = record.id;
                    break;
                }
            }

            if (found) {
                console.log("Editing IP....")
                cf.dnsRecords.edit(zone_id, id, {
                    content: entry.content,
                    type: entry.type,
                    name: entry.name,
                    ttl: 60
                }).catch(function (err) {
                    console.log("Error edit")
                    console.log(err.statusCode, entry, err, id);
                }).then(function (response) {
                    ttl[id] = get_current_timestamp();
                });
            } else {
                console.log("Adding IP....", entry.content);
                cf.dnsRecords.add(zone_id, {
                    content: entry.content,
                    type: entry.type,
                    name: entry.name,
                    ttl: 60
                }).catch(function (err) {
                    console.log("Error add")
                    console.log(err.statusCode, entry);
                }).then(function (response) {
                    if (response) {
                        console.log(response.result.id);
                        ttl[response.result.id] = get_current_timestamp();
                    }
                });
            }
        });
    })
    .catch(function (err) {
        console.log('.catch error', err);
    });
}


async function dnsHandle(request, send, rinfo) {
    try {
        const response = Packet.createResponseFromRequest(request);
        const [question] = request.questions;
        let { name } = question;
        let corr_name;
        if (!name.endsWith('.bobbycar.cloud')) {
            console.error(name)
            return;
        }
        let is_global = name.includes('global');

        if (name.includes("__")) {
            corr_name = name.split('__');
            corr_name = corr_name[corr_name.length-1];
        } else {
            corr_name = name;
        }

        let extracted = extractIPFromDomain(corr_name);
        if (extracted === null) {
            console.warn("Could not extract IP from domain => "+ question.name);
            return;
        } else if (extracted === undefined) {
            return;
        }

        console.warn(extracted.ip, is_global);

        if (extracted) {
            const { ip, username, type } = extracted;
            if (typeof ip !== 'undefined' && typeof username !== 'undefined' && typeof type !== 'undefined') {
                    if (!allowed_users.includes(username)) {
                        return;
                    }
                    console.log(`${username} is now known as ${ip} (type: ${type}) => is_global: ${is_global}`);
                    createDNSEntryOnCloudflare(ip, username, type, is_global);
            }

            response.answers.push({
                name,
                type: Packet.TYPE.A,
                class: Packet.CLASS.IN,
                ttl: 1,
                address: '1.1.1.1'
            });

            send(response);
            return;
        }
    } catch (e) {
        console.log(e, request);
        server.close();
    }
}

function check_ttl() {
    const current_timestamp = get_current_timestamp();
    for (let key in ttl) {
        if (current_timestamp - ttl[key] > 130) {
            let tmp_ttl = ttl[key];
            delete ttl[key];
            cf.dnsRecords.del(zone_id, key)
            .catch(function (err) {
                console.log("Error delete");
                console.log(err.statusCode, key);
                ttl[key] = tmp_ttl;
            })
            .then(function (response) {
                console.log(`Entry ${key} has expired.`);
                delete ttl[key];
            });
        } else {
            // console.log(`Entry ${key} is still valid. (${current_timestamp - ttl[key]})`);
        }
    }
}

function delete_all() {
    let domainsToDelete = [];
    let usernames = [];
    cf.dnsRecords.browse(zone_id)
    .then(function (response) {
        const records = response.result;
        for (let i = 0; i < records.length; i++) {
            let record = records[i];
            if (record.name.includes("ipv6") || record.name.includes("global")) {
                if (!domainsToDelete.includes(record.id))
                    domainsToDelete.push(record.id);
                let username = record.name.split('.bobbycar.cloud')[0].split('.')[1];
                let username_url = `${username}.bobbycar.cloud`;
                if (!usernames.includes(username_url))
                    usernames.push(username_url);
            }
        }

        for (let i = 0; i < records.length; i++) {
            let record = records[i];
            if (usernames.includes(record.name)) {
                if (!domainsToDelete.includes(record.id))
                    domainsToDelete.push(record.id);
            }
        }

        for (let index in domainsToDelete) {
            let id = domainsToDelete[index];
            console.log(`Deleting ${id}`);
            cf.dnsRecords.del(zone_id, id).catch(function (err) {
                console.log(err);
            });
        }

    }).catch(function (err) {
        console.log('err', err);
    });
}

setInterval(() => {
    check_ttl();
}, 1000);
