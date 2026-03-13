let clients = [];

function addClient(res) {
  clients.push(res);
}

function removeClient(res) {
  clients = clients.filter((c) => c !== res);
}

function sendProgress(step, percent) {
  const data = JSON.stringify({ step, percent });
  clients.forEach((client) => client.write(`data: ${data}\n\n`));
}

module.exports = { addClient, removeClient, sendProgress };
