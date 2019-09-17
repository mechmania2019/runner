const { promisify } = require("util");

const mongoose = require("mongoose");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");
const run = require("./run");
const { Match } = require("mm-schemas")(mongoose);

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const DOCKER_CREDENTIALS_PATH = "/gcr/mechmania2017-key.json";
const RUNNER_QUEUE = `runnerQueue`;
// TODO: Update these for the new game engine 
// java -jar GameEngine.jar [gameId] [boardFile] [player1Name] [player2Name] [player1URL] [player2URL] STDOUT
const GAME_PATH = "/game/game.exe";
const MAP_PATH = "/game/Map.json";
const BOT_STARTUP_TIMEOUT = "8"; // 8s

mongoose.connect(process.env.MONGO_URL);
mongoose.Promise = global.Promise;

const s3 = new AWS.S3({
  params: { Bucket: "mechmania2019" }
});

const upload = promisify(s3.upload.bind(s3));

async function main() {
  // Login to docker
  // docker login -u _json_key --password-stdin https://gcr.io
  const dockerLoginProc = execa("docker", [
    "login",
    "-u",
    "_json_key",
    "--password-stdin",
    "https://gcr.io"
  ]);
  fs.createReadStream(DOCKER_CREDENTIALS_PATH).pipe(dockerLoginProc.stdin);
  const { stdout, stderr } = dockerLoginProc;
  stdout.pipe(process.stdout);
  stderr.pipe(process.stderr);
  await dockerLoginProc;

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(RUNNER_QUEUE, { durable: true });
  ch.prefetch(2); // Each instance can run upto 2 games in parallel
  process.on("SIGTERM", async () => {
    console.log("Got SIGTERM");
    await ch.close();
    conn.close();
  });

  console.log(`Listening to ${RUNNER_QUEUE}`);
  ch.consume(
    RUNNER_QUEUE,
    async message => {
      console.log(`Got message - ${message.content.toString()}`);
      const [p1, p2] = JSON.parse(message.content.toString()).sort();
      const images = [p1, p2].map(id => `gcr.io/mechmania2017/${id}`);
      const matchName = `logs/${p1}:${p2}`;

      // Pull docker images
      try {
        console.log(`${p1} v ${p2} - Fetching docker images`);
        await Promise.all(images.map(img => run("docker", ["pull", img])));
      } catch (e) {
        // Sleep 5s and requeue the message
        console.warn("Got an error on docker pull. Sleeping 5s and requeueing");
        await new Promise(r => setTimeout(r, 5000));
        ch.nack(message);
      }

      console.log(`${p1} v ${p2} - Running game`);
      try {
        const { stdout, stderr } = await execa(GAME_PATH, [
          ...images.map(img => `docker run --rm -i ${img}`),
          MAP_PATH,
          BOT_STARTUP_TIMEOUT
        ]);
        // TODO: Save the stderr somewhere too so we have debug infor for each run?
        console.log(`${p1} v ${p2} - Uploading logfile to s3`);
        const data = await upload({
          Key: matchName,
          Body: stdout
        });
        console.log(`${p1} v ${p2} - Uploaded to s3 (${data.Location})`);

        console.log(`${p1} v ${p2} - Parsing logfile for stats`);
        const logLines = stdout.split("\n");
        const numLogLines = logLines.length; // -1 becuause the last line is just '\n'
        const lastRecord = logLines.slice(-1)[0];
        console.log(`${p1} v ${p2} - Last log line is ${lastRecord}`);
        const { Winner: winner } = JSON.parse(lastRecord);
        console.log(`${p1} v ${p2} - Winner is ${winner}`);

        console.log(`${p1} v ${p2} - Creating mongo record`);
        await Match.update(
          {
            key: matchName
          },
          {
            key: matchName,
            length: numLogLines,
            winner
          },
          { upsert: true }
        ).exec();
      } catch (e) {
        console.log(`${p1} v ${p2} - The game engine exited`);
        console.error(e);

        console.log(`${p1} v ${p2} - Considering the game a tie`);
        console.log(`${p1} v ${p2} - Creating mongo record`);
        const match = new Match({
          key: matchName,
          winner: 3
        });
        console.log(`${p1} v ${p2} - Saving mongo record`);
        await match.save();
      }

      ch.ack(message);
    },
    { noAck: false }
  );
}
main().catch(console.trace);
