import * as R from 'ramda';
import { query, isPatchEmpty } from '../../util/db';
import { Sql } from './sql';
import { Helpers } from './helpers';
import { Helpers as environmentHelpers } from '../environment/helpers';
import { Helpers as projectHelpers } from '../project/helpers';
import { Validators as envValidators } from '../environment/validators';
import {
  TaskRegistration,
  newTaskRegistrationFromObject,
  AdvancedTaskDefinitionInterface,
  AdvancedTaskDefinitionType,
  isAdvancedTaskDefinitionSystemLevelTask,
  getAdvancedTaskDefinitionType
} from './models/taskRegistration';
import * as advancedTaskArgument from './models/advancedTaskDefinitionArgument'
import sql from '../user/sql';
import convertDateToMYSQLDateTimeFormat from '../../util/convertDateToMYSQLDateTimeFormat';
import * as advancedTaskToolbox from './advancedtasktoolbox';
import { IKeycloakAuthAttributes, KeycloakUnauthorizedError } from '../../util/auth';
import { Environment } from '../../resolvers';
import { generateTaskName } from '@lagoon/commons/dist/util';

enum AdvancedTaskDefinitionTarget {
  Group,
  Project,
  Environment,
  SystemWide
}

const TASK_PERMISSION_LEVELS = ['GUEST', 'MAINTAINER', 'DEVELOPER'];

const taskStatusTypeToString = R.cond([
  [R.equals('ACTIVE'), R.toLower],
  [R.equals('SUCCEEDED'), R.toLower],
  [R.equals('FAILED'), R.toLower],
  [R.T, R.identity]
]);

const PermissionsToRBAC = (permission: string) => {
  return `invoke:${permission.toLowerCase()}`;
};

export const allAdvancedTaskDefinitions = async (root, args, {sqlClientPool, hasPermission, models}) => {
  //is the user a system admin?
  try {
    await hasPermission('advanced_task','create:advanced');
  } catch(e) {
    throw new KeycloakUnauthorizedError("Only system admins have access to view all advanced task definitions");
  }

  let adTaskDefs = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitions()
  );

  const atf = advancedTaskToolbox.advancedTaskFunctions(sqlClientPool, models, hasPermission);

  for(let i = 0; i < adTaskDefs.length; i++) {
    adTaskDefs[i].advancedTaskDefinitionArguments = await atf.advancedTaskDefinitionArguments(adTaskDefs[i].id);
  }

  return adTaskDefs;
}

export const advancedTaskDefinitionById = async (
  root,
  { id },
  { sqlClientPool, hasPermission, models }
) => {

  const atf = advancedTaskToolbox.advancedTaskFunctions(sqlClientPool, models, hasPermission);
  await hasPermission('task', 'view', {});
  const advancedTaskDef = await atf.advancedTaskDefinitionById(
    id
  );

  if(await atf.permissions.canUserSeeTaskDefinition(advancedTaskDef) == false) {
    throw new Error("You do not have permission");
  }

  return advancedTaskDef;
};


export const getRegisteredTasksByEnvironmentId = async (
  { id },
  {},
  { sqlClientPool, hasPermission, models }
) => {
  let rows;

  if (!R.isEmpty(id)) {
    rows = await resolveTasksForEnvironment(
      {},
      { environment: id },
      { sqlClientPool, hasPermission, models }
    );
  }

  return rows;
};

export const resolveTasksForEnvironment = async (
  root,
  { environment },
  { sqlClientPool, hasPermission, models }
) => {
  const environmentDetails = await environmentHelpers(
    sqlClientPool
  ).getEnvironmentById(environment);
  await hasPermission('task', 'view', {
    project: environmentDetails.project
  });

  let environmentRows = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitionsForEnvironment(environment)
  );

  const proj = await projectHelpers(sqlClientPool).getProjectByEnvironmentId(
    environment
  );

  let projectRows = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitionsForProject(proj.project)
  );

  const projectGroups = await models.GroupModel.loadGroupsByProjectId(
    proj.projectId
  );

  const projectGroupsFiltered = R.pluck('name', projectGroups);

  let groupRows = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitionsForGroups(projectGroupsFiltered)
  );

  //@ts-ignore
  let rows = R.uniqBy(o => o.name, R.concat(R.concat(environmentRows, projectRows), groupRows));

  //now we filter the permissions
  const currentUsersPermissionForProject = await currentUsersAdvancedTaskRBACRolesForProject(
    hasPermission,
    proj.projectId
  );

  //@ts-ignore
  rows = R.filter(e => currentUsersPermissionForProject.includes(e.permission), rows);

  const atf = advancedTaskToolbox.advancedTaskFunctions(sqlClientPool, models, hasPermission);

  let typeValidatorFactory = advancedTaskArgument.advancedTaskDefinitionTypeFactory(sqlClientPool, null, environment);
  // TODO: this needs to be somehow refactored into all lookups.
  // we might need a "load task" function or something.
  for(let i = 0; i < rows.length; i++ ) {
    //@ts-ignore
    let argsForTask = await atf.advancedTaskDefinitionArguments(rows[i].id);
    let processedArgs = [];
    for(let i = 0; i < argsForTask.length; i++) {
      let processing = argsForTask[i];
      let validator: advancedTaskArgument.ArgumentBase = typeValidatorFactory(processing.type);
      processing.range = await validator.getArgumentRange();
      processedArgs.push(processing);
    }

    //@ts-ignore
    rows[i].advancedTaskDefinitionArguments = processedArgs;
  }

  return rows;
};


const currentUsersAdvancedTaskRBACRolesForProject = async (
  hasPermission,
  projectId: number
) => {
  const rbacPermissions = TASK_PERMISSION_LEVELS;
  let effectivePermissions = [];
  for (let i = 0; i < rbacPermissions.length; i++) {
    try {
      await hasPermission(
        'advanced_task',
        PermissionsToRBAC(rbacPermissions[i]),
        {
          project: projectId
        }
      );
      effectivePermissions.push(rbacPermissions[i]);
    } catch (ex) {
      //we do nothing if this fails ...
    }
  }
  return effectivePermissions;
};

export const advancedTaskDefinitionArgumentById = async (
  root,
  id,
  { sqlClientPool, hasPermission }
) => {
  const rows = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitionArgumentById(id)
  );
  await hasPermission('environment', 'view', {
    project: id
  });

  return R.prop(0, rows);
};

export const addAdvancedTaskDefinition = async (
  root,
  {
    input
  },
  { sqlClientPool, hasPermission, models, userActivityLogger }
) => {

  const {
    name,
    description,
    image = '',
    type,
    service,
    command,
    project,
    groupName,
    environment,
    permission,
    advancedTaskDefinitionArguments,
    created,
    confirmationText,
  } = input;

  const atb = advancedTaskToolbox.advancedTaskFunctions(
    sqlClientPool, models, hasPermission
  );

  let projectObj = await getProjectByEnvironmentIdOrProjectId(
    sqlClientPool,
    environment,
    project
  );

  await checkAdvancedTaskPermissions(input, hasPermission, models, projectObj);

  validateAdvancedTaskDefinitionData(input, image, command, type);

  //let's see if there's already an advanced task definition with this name ...
  // Note: this will all be scoped to either System, group, project, or environment
  // hence the filters below.
  const rows = await query(
    sqlClientPool,
    Sql.selectAdvancedTaskDefinitionByNameProjectEnvironmentAndGroup(
      name,
      project,
      environment,
      groupName
    )
  );
  let taskDef = R.prop(0, rows);

  if (taskDef) {
    // At this point, `taskDefMatchedIncoming` will indicate
    // whether the incoming details for a similarly named
    // task _scoped to the system/group/project/environment_
    // exists. If it does, we return its id instead of creating it.
    const taskDefMatchesIncoming =
      taskDef.description == description &&
      taskDef.image == image &&
      taskDef.type == type &&
      (taskDef.type == AdvancedTaskDefinitionType.image ||
        taskDef.command == command);

    // if the similarly named task (scoped to system/group/project/environment) does
    // not match the existing definition, we have to reject this request.
    // A user should delete the task before creating a similarly named, identically scoped
    // task
    if (!taskDefMatchesIncoming) {
      let errorMessage = `Task '${name}' with different definition already exists `;
      if (projectObj) {
        errorMessage += ` for Project ${projectObj.name}`;
      }
      if (environment) {
        errorMessage += ` on environment number ${environment}`;
      }
      if (groupName) {
        errorMessage += ` and group ${groupName}`;
      }
      throw Error(errorMessage);
    }
    return taskDef;
  }

  const { insertId } = await query(
    sqlClientPool,
    Sql.insertAdvancedTaskDefinition({
      id: null,
      name,
      description,
      image,
      command,
      created,
      type,
      service,
      project,
      environment,
      group_name: groupName,
      permission,
      confirmation_text: confirmationText,
    })
  );

  //now attach arguments
  if(advancedTaskDefinitionArguments) {
    for(let i = 0; i < advancedTaskDefinitionArguments.length; i++) {
      await query(
        sqlClientPool,
        Sql.insertAdvancedTaskDefinitionArgument({
          id: null,
          advanced_task_definition: insertId,
          name: advancedTaskDefinitionArguments[i].name,
          type: advancedTaskDefinitionArguments[i].type,
          displayName: advancedTaskDefinitionArguments[i].displayName,
        })
      );
    }
  }

  userActivityLogger(`User added advanced task definition '${name}'`, {
      project: project,
      event: 'api:updateTaskDefinition',
      payload: {
        taskDef: insertId
      }
    });

  return await atb.advancedTaskDefinitionById(
    insertId
  );
};

export const updateAdvancedTaskDefinition = async (
  root,
  {
    input: {
      id,
      patch,
      patch: {
        name,
        description,
        image = '',
        type,
        service,
        command,
        permission,
        advancedTaskDefinitionArguments,
        confirmationText
      }
    }
  },
  { sqlClientPool, hasPermission, models, userActivityLogger }
) => {
  if (isPatchEmpty({ patch })) {
    throw new Error('Input patch requires at least 1 attribute');
  }

  const atb = advancedTaskToolbox.advancedTaskFunctions(
    sqlClientPool, models, hasPermission
  );

  let task = await atb.advancedTaskDefinitionById(id);

  let projectObj = await getProjectByEnvironmentIdOrProjectId(
    sqlClientPool,
    task.environment,
    task.project
  );


  await checkAdvancedTaskPermissions(task, hasPermission, models, projectObj);

  validateAdvancedTaskDefinitionData(patch, image, command, type);

  //We actually don't want them to be able to update group, project, environment - so those aren't
  await query(
    sqlClientPool,
    Sql.updateAdvancedTaskDefinition({
      id,
      patch: {
        name,
        description,
        image,
        command,
        service,
        permission,
        confirmation_text: confirmationText
      }
    })
  );

  try {
    if (advancedTaskDefinitionArguments) {
      //remove current arguments from task defintion before we add new ones
      await query(
        sqlClientPool,
        Sql.deleteAdvancedTaskDefinitionArgumentByTaskDef(id)
      );

      //add advanced task definition arguments
      for(let i = 0; i < advancedTaskDefinitionArguments.length; i++) {
        await query(
          sqlClientPool,
          Sql.insertAdvancedTaskDefinitionArgument({
            id: null,
            advanced_task_definition: id,
            name: advancedTaskDefinitionArguments[i].name,
            displayName: advancedTaskDefinitionArguments[i].displayName,
            type: advancedTaskDefinitionArguments[i].type
          })
        );
      }
    }

    userActivityLogger(`User updated advanced task definition '${id}'`, {
      project: task.project,
      event: 'api:updateTaskDefinition',
      payload: {
        taskDef: id
      }
    });

    const atf = advancedTaskToolbox.advancedTaskFunctions(sqlClientPool, models, hasPermission);
    return await atf.advancedTaskDefinitionById(id);
  } catch (error) {
    throw error
  }
}


const getProjectByEnvironmentIdOrProjectId = async (
  sqlClientPool,
  environment,
  project
) => {
  if (environment) {
    let projByEnv = await projectHelpers(sqlClientPool).getProjectByEnvironmentId(
      environment
    );
    return await projectHelpers(sqlClientPool).getProjectById(projByEnv.project);
  }
  if (project) {
    return await projectHelpers(sqlClientPool).getProjectById(project);
  }
  return null;
};

export const invokeRegisteredTask = async (
  root,
  { advancedTaskDefinition, environment, argumentValues },
  { sqlClientPool, hasPermission, models }
) => {
  await envValidators(sqlClientPool).environmentExists(environment);

  let task = await getNamedAdvancedTaskForEnvironment(
    sqlClientPool,
    hasPermission,
    advancedTaskDefinition,
    environment,
    models
  );

  const atb = advancedTaskToolbox.advancedTaskFunctions(
    sqlClientPool, models, hasPermission
  );

  //here we want to validate the incoming arguments
  let taskArgs = await atb.advancedTaskDefinitionArguments(task.id);

  //let's grab something that'll be able to tell us whether our arguments
  //are valid
  const typeValidatorFactory = advancedTaskArgument.advancedTaskDefinitionTypeFactory(sqlClientPool, task, environment);

  if(argumentValues) {
    for(let i = 0; i < argumentValues.length; i++) {
      //grab the type for this one
      let {advancedTaskDefinitionArgumentName, value} = argumentValues[i];
      let taskArgDef = R.find(R.propEq('name', advancedTaskDefinitionArgumentName))(taskArgs);
      if(!taskArgDef) {
        throw new Error(`Cannot find argument type named ${advancedTaskDefinitionArgumentName}`);
      }

      //@ts-ignore
      let validator: advancedTaskArgument.ArgumentBase = typeValidatorFactory(taskArgDef.type);

      if(!(await validator.validateInput(value))) {
        //@ts-ignore
        throw new Error(`Invalid input "${value}" for type "${taskArgDef.type}" given for argument "${advancedTaskDefinitionArgumentName}"`);
      }
    };
  }


  const environmentDetails = await environmentHelpers(
    sqlClientPool
  ).getEnvironmentById(environment);

  await hasPermission('advanced_task', PermissionsToRBAC(task.permission), {
    project: environmentDetails.project
  });

  switch (task.type) {
      case TaskRegistration.TYPE_STANDARD:

        let taskCommandEnvs = '';
        let taskCommand = "";

        if(argumentValues && argumentValues.length > 0) {
          taskCommandEnvs = R.reduce((acc, val) => {
            //@ts-ignore
            return `${acc} ${val.advancedTaskDefinitionArgumentName}="${val.value}"`
          }, taskCommandEnvs, argumentValues);

          taskCommand += `${taskCommandEnvs}; `;
        }

        taskCommand += `${task.command}`;

        const taskData = await Helpers(sqlClientPool).addTask({
          name: task.name,
          taskName: generateTaskName(),
          environment: environment,
          service: task.service,
          command: taskCommand,
          execute: true
        });
        return taskData;
        break;
      case TaskRegistration.TYPE_ADVANCED:
        // the return data here is basically what gets dropped into the DB.

        // get any arguments ready for payload
        let payload = {};
        if(argumentValues) {
          for(let i = 0; i < argumentValues.length; i++) {
            //@ts-ignore
            payload[argumentValues[i].advancedTaskDefinitionArgumentName] = argumentValues[i].value;
          }
        }


        const advancedTaskData = await Helpers(sqlClientPool).addAdvancedTask({
          name: task.name,
          taskName: generateTaskName(),
          created: undefined,
          started: undefined,
          completed: undefined,
          environment,
          service: task.service || 'cli',
          image: task.image, //the return data here is basically what gets dropped into the DB.
          payload: payload,
          remoteId: undefined,
          execute: true
        });

        return advancedTaskData;
        break;
      default:
        throw new Error('Cannot find matching task');
        break;
    }
};

const getNamedAdvancedTaskForEnvironment = async (
  sqlClientPool,
  hasPermission,
  advancedTaskDefinition,
  environment,
  models
):Promise<AdvancedTaskDefinitionInterface> => {
  let rows = await resolveTasksForEnvironment(
    {},
    { environment },
    { sqlClientPool, hasPermission, models }
  );
  //@ts-ignore
  const taskDef = R.find(o => o.id == advancedTaskDefinition, rows);
  if (taskDef == undefined) {
    throw new Error(
      `Task registration '${advancedTaskDefinition}' could not be found.`
    );
  }
  //@ts-ignore
  return <AdvancedTaskDefinitionInterface>taskDef;
};


export const deleteAdvancedTaskDefinition = async (
  root,
  { advancedTaskDefinition },
  { sqlClientPool, hasPermission, models }
) => {
  //load up advanced task definition ...
  const atb = advancedTaskToolbox.advancedTaskFunctions(
    sqlClientPool, models, hasPermission
  );
  const adTaskDef = await atb.advancedTaskDefinitionById(advancedTaskDefinition);

  if (!adTaskDef) {
    throw new Error(
      `Advanced Task ID ${addAdvancedTaskDefinition} cannot be loaded`
    );
  }

  //determine type and check user perms ...
  switch (getAdvancedTaskTarget(adTaskDef)) {
    case AdvancedTaskDefinitionTarget.Environment:
    case AdvancedTaskDefinitionTarget.Project:
      let projectObj = await getProjectByEnvironmentIdOrProjectId(
        sqlClientPool,
        adTaskDef.environment,
        adTaskDef.project
      );

      await hasPermission('task', `add:production`, {
        project: projectObj.id
      });

      break;
    case AdvancedTaskDefinitionTarget.Group:
      const group = await models.GroupModel.loadGroupByIdOrName({
        name: adTaskDef.groupName
      });
      await hasPermission('group', 'update', {
        group: group.id
      });
      break;
    default:
      throw Error('Images and System Wide Tasks are not yet supported');
  }

  const rows = await query(
    sqlClientPool,
    Sql.selectPermsForTask(advancedTaskDefinition)
  );


  await query(
    sqlClientPool,
    Sql.deleteAdvancedTaskDefinitionArgumentsForTask(advancedTaskDefinition)
  );

  await query(
    sqlClientPool,
    Sql.deleteAdvancedTaskDefinition(advancedTaskDefinition)
  );

  return 'success';
};

const getAdvancedTaskTarget = advancedTask => {
  if (advancedTask.environment != null) {
    return AdvancedTaskDefinitionTarget.Environment;
  } else if (advancedTask.project != null) {
    return AdvancedTaskDefinitionTarget.Project;
  } else if (advancedTask.groupName != null) {
    return AdvancedTaskDefinitionTarget.Group;
  } else {
    //Currently, we don't support environment level tasks
    throw Error('Images and System Wide Tasks are not yet supported');
    // return AdvancedTaskDefinitionTarget.Environment
  }
};

// const advancedTaskFunctions = sqlClientPool => {
//   return {
//     advancedTaskDefinitionById: async function(id) {
//       const rows = await query(
//         sqlClientPool,
//         Sql.selectAdvancedTaskDefinition(id)
//       );
//       let taskDef = R.prop(0, rows);
//       taskDef.advancedTaskDefinitionArguments = await this.advancedTaskDefinitionArguments(
//         taskDef.id
//       );
//       return taskDef;
//     },
//     advancedTaskDefinitionArguments: async function(task_definition_id) {
//       const rows = await query(
//         sqlClientPool,
//         Sql.selectAdvancedTaskDefinitionArguments(task_definition_id)
//       );
//       let taskDefArgs = rows;
//       return taskDefArgs;
//     }
//   };
// };

function validateAdvancedTaskDefinitionData(input: any, image: any, command: any, type: any) {
  switch (getAdvancedTaskDefinitionType(<AdvancedTaskDefinitionInterface>input)) {
    case AdvancedTaskDefinitionType.image:
      if (!image || 0 === image.length) {
        throw new Error(
          'Unable to create image based task with no image supplied'
        );
      }
      break;
    case AdvancedTaskDefinitionType.command:
      if (!command || 0 === command.length) {
        throw new Error('Unable to create Advanced task definition');
      }
      break;
    default:
      throw new Error(
        'Undefined Advanced Task Definition type passed at creation time: ' +
        type
      );
      break;
  }
}

async function checkAdvancedTaskPermissions(input:AdvancedTaskDefinitionInterface, hasPermission: any, models: any, projectObj: any) {
  if (isAdvancedTaskDefinitionSystemLevelTask(input)) {
    //if they pass this, they can do basically anything
    //In the first release, we're not actually supporting this
    //TODO: add checks once images are officially supported - for now, throw an error
    throw Error('Adding Images and System Wide Tasks are not yet supported');
  } else if (getAdvancedTaskDefinitionType(input) == AdvancedTaskDefinitionType.image) {
    //We're only going to allow administrators to add these for now ...
    await hasPermission('advanced_task', 'create:advanced');
  } else if (input.groupName) {
    const group = await models.GroupModel.loadGroupByIdOrName({
      name: input.groupName
    });
    await hasPermission('group', 'update', {
      group: group.id
    });
  } else if (projectObj) {
    //does the user have permission to actually add to this?
    //i.e. are they a maintainer?
    await hasPermission('task', `add:production`, {
      project: projectObj.id
    });
  }
}
