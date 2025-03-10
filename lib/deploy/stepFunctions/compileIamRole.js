'use strict';

const _ = require('lodash');
const BbPromise = require('bluebird');
const path = require('path');
const { isIntrinsic, translateLocalFunctionNames } = require('../../utils/aws');

function getTaskStates(states) {
  return _.flatMap(states, (state) => {
    switch (state.Type) {
      case 'Task': {
        return [state];
      }
      case 'Parallel': {
        const parallelStates = _.flatMap(state.Branches, branch => _.values(branch.States));
        return getTaskStates(parallelStates);
      }
      default: {
        return [];
      }
    }
  });
}

function sqsQueueUrlToArn(serverless, queueUrl) {
  const regex = /https:\/\/sqs.(.*).amazonaws.com\/(.*)\/(.*)/g;
  const match = regex.exec(queueUrl);
  if (match) {
    const region = match[1];
    const accountId = match[2];
    const queueName = match[3];
    return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
  } if (isIntrinsic(queueUrl) && queueUrl.Ref) {
    // most likely we'll see a { Ref: LogicalId }, which we need to map to
    // { Fn::GetAtt: [ LogicalId, Arn ] } to get the ARN
    return {
      'Fn::GetAtt': [queueUrl.Ref, 'Arn'],
    };
  }
  serverless.cli.consoleLog(`Unable to parse SQS queue url [${queueUrl}]`);
  return [];
}

function getSqsPermissions(serverless, state) {
  if (_.has(state, 'Parameters.QueueUrl')
      || _.has(state, ['Parameters', 'QueueUrl.$'])) {
    // if queue URL is provided by input, then need pervasive permissions (i.e. '*')
    const queueArn = state.Parameters['QueueUrl.$']
      ? '*'
      : sqsQueueUrlToArn(serverless, state.Parameters.QueueUrl);
    return [{ action: 'sqs:SendMessage', resource: queueArn }];
  }
  serverless.cli.consoleLog('SQS task missing Parameters.QueueUrl or Parameters.QueueUrl.$');
  return [];
}

function getSnsPermissions(serverless, state) {
  if (_.has(state, 'Parameters.TopicArn')
      || _.has(state, ['Parameters', 'TopicArn.$'])) {
    // if topic ARN is provided by input, then need pervasive permissions
    const topicArn = state.Parameters['TopicArn.$'] ? '*' : state.Parameters.TopicArn;
    return [{ action: 'sns:Publish', resource: topicArn }];
  }
  serverless.cli.consoleLog('SNS task missing Parameters.TopicArn or Parameters.TopicArn.$');
  return [];
}

function getDynamoDBArn(tableName) {
  if (isIntrinsic(tableName) && tableName.Ref) {
    // most likely we'll see a { Ref: LogicalId }, which we need to map to
    // { Fn::GetAtt: [ LogicalId, Arn ] } to get the ARN
    return {
      'Fn::GetAtt': [tableName.Ref, 'Arn'],
    };
  }

  return {
    'Fn::Join': [
      ':',
      [
        'arn:aws:dynamodb',
        { Ref: 'AWS::Region' },
        { Ref: 'AWS::AccountId' },
        `table/${tableName}`,
      ],
    ],
  };
}

function getBatchPermissions() {
  return [{
    action: 'batch:SubmitJob,batch:DescribeJobs,batch:TerminateJob',
    resource: '*',
  }, {
    action: 'events:PutTargets,events:PutRule,events:DescribeRule',
    resource: {
      'Fn::Join': [
        ':',
        [
          'arn:aws:events',
          { Ref: 'AWS::Region' },
          { Ref: 'AWS::AccountId' },
          'rule/StepFunctionsGetEventsForBatchJobsRule',
        ],
      ],
    },
  }];
}

function getGluePermissions() {
  return [{
    action: 'glue:StartJobRun,glue:GetJobRun,glue:GetJobRuns,glue:BatchStopJobRun',
    resource: '*',
  }];
}

function getEcsPermissions() {
  return [{
    action: 'ecs:RunTask,ecs:StopTask,ecs:DescribeTasks,iam:PassRole',
    resource: '*',
  }, {
    action: 'events:PutTargets,events:PutRule,events:DescribeRule',
    resource: {
      'Fn::Join': [
        ':',
        [
          'arn:aws:events',
          { Ref: 'AWS::Region' },
          { Ref: 'AWS::AccountId' },
          'rule/StepFunctionsGetEventsForECSTaskRule',
        ],
      ],
    },
  }];
}

function getDynamoDBPermissions(action, state) {
  const tableArn = state.Parameters['TableName.$']
    ? '*'
    : getDynamoDBArn(state.Parameters.TableName);

  return [{
    action,
    resource: tableArn,
  }];
}

function getLambdaPermissions(state) {
  // function name can be name-only, name-only with alias, full arn or partial arn
  // https://docs.aws.amazon.com/lambda/latest/dg/API_Invoke.html#API_Invoke_RequestParameters
  const functionName = state.Parameters.FunctionName;
  if (_.isString(functionName)) {
    const segments = functionName.split(':');

    let functionArn;
    if (functionName.startsWith('arn:aws:lambda')) {
      // full ARN
      functionArn = functionName;
    } else if (segments.length === 3 && segments[0].match(/^\d+$/)) {
      // partial ARN
      functionArn = {
        'Fn::Sub': `arn:aws:lambda:\${AWS::Region}:${functionName}`,
      };
    } else {
      // name-only (with or without alias)
      functionArn = {
        'Fn::Sub': `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${functionName}`,
      };
    }

    return [{
      action: 'lambda:InvokeFunction',
      resource: functionArn,
    }];
  } if (_.has(functionName, 'Fn::GetAtt')) {
    // because the FunctionName parameter can be either a name or ARN
    // so you should be able to use Fn::GetAtt here to get the ARN
    return [{
      action: 'lambda:InvokeFunction',
      resource: translateLocalFunctionNames.bind(this)(functionName),
    }];
  } if (_.has(functionName, 'Ref')) {
    // because the FunctionName parameter can be either a name or ARN
    // so you should be able to use Ref here to get the function name
    return [{
      action: 'lambda:InvokeFunction',
      resource: {
        'Fn::Sub': [
          'arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${FunctionName}',
          {
            FunctionName: translateLocalFunctionNames.bind(this)(functionName),
          },
        ],
      },
    }];
  }

  // hope for the best...
  return [{
    action: 'lambda:InvokeFunction',
    resource: functionName,
  }];
}

// if there are multiple permissions with the same action, then collapsed them into one
// permission instead, and collect the resources into an array
function consolidatePermissionsByAction(permissions) {
  return _.chain(permissions)
    .groupBy(perm => perm.action)
    .mapValues((perms) => {
      // find the unique resources
      let resources = _.uniqWith(_.flatMap(perms, p => p.resource), _.isEqual);
      if (_.includes(resources, '*')) {
        resources = '*';
      }

      return {
        action: perms[0].action,
        resource: resources,
      };
    })
    .values()
    .value(); // unchain
}

function consolidatePermissionsByResource(permissions) {
  return _.chain(permissions)
    .groupBy(p => JSON.stringify(p.resource))
    .mapValues((perms) => {
      // find unique actions
      const actions = _.uniq(_.flatMap(perms, p => p.action.split(',')));

      return {
        action: actions.join(','),
        resource: perms[0].resource,
      };
    })
    .values()
    .value(); // unchain
}

function getIamPermissions(taskStates) {
  return _.flatMap(taskStates, (state) => {
    switch (state.Resource) {
      case 'arn:aws:states:::sqs:sendMessage':
      case 'arn:aws:states:::sqs:sendMessage.waitForTaskToken':
        return getSqsPermissions(this.serverless, state);

      case 'arn:aws:states:::sns:publish':
      case 'arn:aws:states:::sns:publish.waitForTaskToken':
        return getSnsPermissions(this.serverless, state);

      case 'arn:aws:states:::dynamodb:updateItem':
        return getDynamoDBPermissions('dynamodb:UpdateItem', state);
      case 'arn:aws:states:::dynamodb:putItem':
        return getDynamoDBPermissions('dynamodb:PutItem', state);
      case 'arn:aws:states:::dynamodb:getItem':
        return getDynamoDBPermissions('dynamodb:GetItem', state);
      case 'arn:aws:states:::dynamodb:deleteItem':
        return getDynamoDBPermissions('dynamodb:DeleteItem', state);

      case 'arn:aws:states:::batch:submitJob.sync':
      case 'arn:aws:states:::batch:submitJob':
        return getBatchPermissions();

      case 'arn:aws:states:::glue:startJobRun.sync':
      case 'arn:aws:states:::glue:startJobRun':
        return getGluePermissions();

      case 'arn:aws:states:::ecs:runTask.sync':
      case 'arn:aws:states:::ecs:runTask.waitForTaskToken':
      case 'arn:aws:states:::ecs:runTask':
        return getEcsPermissions();

      case 'arn:aws:states:::lambda:invoke':
      case 'arn:aws:states:::lambda:invoke.waitForTaskToken':
        return getLambdaPermissions.bind(this)(state);

      default:
        if (isIntrinsic(state.Resource) || state.Resource.startsWith('arn:aws:lambda')) {
          return [{
            action: 'lambda:InvokeFunction',
            resource: translateLocalFunctionNames.bind(this)(state.Resource),
          }];
        }
        this.serverless.cli.consoleLog('Cannot generate IAM policy statement for Task state', state);
        return [];
    }
  });
}

function getIamStatements(iamPermissions) {
  // when the state machine doesn't define any Task states, and therefore doesn't need ANY
  // permission, then we should follow the behaviour of the AWS console and return a policy
  // that denies access to EVERYTHING
  if (_.isEmpty(iamPermissions)) {
    return [{
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
    }];
  }

  return iamPermissions.map(p => ({
    Effect: 'Allow',
    Action: p.action.split(','),
    Resource: p.resource,
  }));
}

module.exports = {
  compileIamRole() {
    const customRolesProvided = [];
    let iamPermissions = [];
    this.getAllStateMachines().forEach((stateMachineName) => {
      const stateMachineObj = this.getStateMachine(stateMachineName);
      customRolesProvided.push('role' in stateMachineObj);

      const taskStates = getTaskStates(stateMachineObj.definition.States);
      iamPermissions = iamPermissions.concat(getIamPermissions.bind(this)(taskStates));
    });
    if (_.isEqual(_.uniq(customRolesProvided), [true])) {
      return BbPromise.resolve();
    }

    const iamRoleStateMachineExecutionTemplate = this.serverless.utils.readFileSync(
      path.join(__dirname,
        '..',
        '..',
        'iam-role-statemachine-execution-template.txt'),
    );

    iamPermissions = consolidatePermissionsByAction(iamPermissions);
    iamPermissions = consolidatePermissionsByResource(iamPermissions);

    const iamStatements = getIamStatements(iamPermissions);

    const iamRoleJson = iamRoleStateMachineExecutionTemplate
      .replace('[region]', this.options.region)
      .replace('[PolicyName]', this.getStateMachinePolicyName())
      .replace('[Statements]', JSON.stringify(iamStatements));

    const iamRoleStateMachineLogicalId = this.getiamRoleStateMachineLogicalId();
    const newIamRoleStateMachineExecutionObject = {
      [iamRoleStateMachineLogicalId]: JSON.parse(iamRoleJson),
    };

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
      newIamRoleStateMachineExecutionObject);
    return BbPromise.resolve();
  },
};
