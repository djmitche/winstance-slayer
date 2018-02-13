const aws = require('aws-sdk');
const fs = require('fs');
const taskcluster = require('taskcluster-client');

const WORKERTYPE_PATTERN = process.env.WORKERTYPE_PATTERN;

async function fixRegion(region) {
  let lastcall = new Date();
  lastcall.setMinutes(lastcall.getMinutes() - 10);

  console.log(`killing impaired instances which are impaired since before ${lastcall} in ${region}`);
  
  let ec2 = new aws.EC2({region});  

  let impairedInstances = await ec2.describeInstanceStatus({
    Filters: [
      {Name: 'instance-status.status', Values: ['impaired']}
    ],
  }).promise();

  let impairedInstanceIds = impairedInstances.InstanceStatuses.filter(x => {
    let earliest = new Date();
    for (let impairment of x.InstanceStatus.Details) {
      let impairmentTime = new Date(impairment.ImpairedSince);
      if (impairmentTime < earliest) {
        earliest = impairmentTime;
      }
    }
    return earliest < lastcall;
  }).map(x => x.InstanceId);

  if (impairedInstanceIds.length === 0) {
    console.log('no impaired instances in ' + region);
    return;
  }

  let reservationsWithImpairedInstances = await ec2.describeInstances({
    InstanceIds: impairedInstanceIds,
    Filters: [
      {Name: 'tag:Owner', Values: ['ec2-manager-production', 'aws-provisioner-v1-managed']},
      {Name: 'tag:Name', Values: [WORKERTYPE_PATTERN]},
    ],
  }).promise();

  let toKill = [];
  for (let res of reservationsWithImpairedInstances.Reservations) {
    res.Instances.forEach(inst => {
      let name;
      inst.Tags.forEach(tag => {
        if (tag.Key == 'Name') {
          name = tag.Value;
        }
      });
      console.log(`${region} - ${inst.InstanceId}: ${name} -- will kill`);
    });
    Array.prototype.push.apply(toKill, res.Instances.map(x => x.InstanceId));
  }

  if (toKill.length === 0) {
    console.log('no impaired instances which match the glob "' + WORKERTYPE_PATTERN + '" in ' + region);
    return;
  }

  let params = {
    InstanceIds: toKill
  };

  if (process.env.DRY_RUN) {
    console.log(`This is a dry, but would have run "new aws.EC2({region: '${region}'}).rebootInstance(${JSON.stringify(params)});"`);
    return {dry_run_would_kill: toKill};
  } else {
    let response = await ec2.rebootInstances(params).promise();
    console.log('finished reboting in ' + region);
    console.log('aws said: ' + JSON.stringify(response, null, 2));
    return {killed: toKill};
  }
}

async function main() {
  if (!process.env.AWS_ACCESS_KEY) {
    console.log('no access credentials provided; trying to fetch from http://taskcluster');
    const secrets = new Taskcluster.Secrets({baseUrl: 'http://taskcluster/secrets/v1'});
    const creds = await secrets.get('project/releng/winstance-slayer/aws-creds');
    process.env.AWS_ACCESS_KEY_ID = creds.secret.AWS_ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = creds.secret.AWS_SECRET_ACCESS_KEY;
  }

  if (!WORKERTYPE_PATTERN) {
    console.log('specify WORKERTYPE_PATTERN');
    process.exit(1);
  }

  try {
    let regions = [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'eu-central-1',
    ];

    let result = {started: new Date()};
    await Promise.all(regions.map(async region => {
      let regionResult = await fixRegion(region);
    
      if (result) {
        result[region] = regionResult;
      }
    }));
    result.ended = new Date();

    let data = '\n---\n' + JSON.stringify(result, null, 2);

    fs.appendFileSync('termination-log.yml', data);
  } catch (err) {
    console.log(err.stack || err);
    throw err;
  }
}

main().then(x=>{}, console.error);
