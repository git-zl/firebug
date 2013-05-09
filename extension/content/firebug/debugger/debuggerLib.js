/* See license.txt for terms of usage */

/*jshint esnext:true, es5:true, curly:false*/
/*global FBTrace:true, Components:true, define:true */


define([
    "firebug/lib/wrapper",
],
function(Wrapper) {

"use strict";

// ********************************************************************************************* //
// Constants

var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

Cu["import"]("resource://gre/modules/devtools/dbg-server.jsm");

// Debugees
var dglobalWeakMap = new WeakMap();

// Module object
var DebuggerLib = {};

// ********************************************************************************************* //
// Implementation

// xxxHonza: for now Firebug is accesing JSD2 API directly in some cases, but as soon
// as RDP is supported the entire DebuggerLib module should be used only on the server side.

/**
 * Unwraps the value of a debuggee object.
 *
 * @param obj {Debugger.Object} The debuggee object to unwrap
 * @param global {Window} The unwrapped global (window)
 * @param dglobal {Debugger.Object} The debuggee global object
 *
 * @return {object} the unwrapped object
 */
DebuggerLib.unwrapDebuggeeValue = function(obj, global, dglobal)
{
    // If not a debuggee object, return it immediately.
    if (typeof obj !== "object" || obj === null)
        return obj;

    if (obj.unsafeDereference)
        return Wrapper.unwrapObject(obj.unsafeDereference());

    if (!global || !dglobal)
    {
        TraceError.sysout("debuggerClientModule.getObject; You need patch from bug 837723");
        return;
    }

    // Define a new property to get the debuggee value.
    dglobal.defineProperty("_firebugUnwrappedDebuggerObject", {
        value: obj,
        writable: true,
        configurable: true
    });

    // Get the debuggee value using the property through the unwrapped global object.
    return global._firebugUnwrappedDebuggerObject;
};

/**
 * Gets or creates the debuggee global for the given global object
 *
 * @param {Window} global The global object
 * @param {*} context The Firebug context
 *
 * @return {Debuggee Window} The debuggee global
 */
DebuggerLib.getDebuggeeGlobal = function(context, global)
{
    global = global || context.getCurrentGlobal();

    var dglobal = dglobalWeakMap.get(global.document);
    if (!dglobal)
    {
        var dbg = getInactiveDebuggerForContext(context);
        if (!dbg)
            return;

        // xxxFlorent: For a reason I ignore, there are some conflicts with the ShareMeNot addon.
        //   As a workaround, we unwrap the global object.
        //   TODO see what cause that behaviour, why, and if there are no other addons in that case.
        var contentView = Wrapper.getContentView(global);
        dglobal = dbg.addDebuggee(contentView);
        dbg.removeDebuggee(contentView);
        dglobalWeakMap.set(global.document, dglobal);

        if (FBTrace.DBG_DEBUGGER)
            FBTrace.sysout("new debuggee global instance created", dglobal);
    }
    return dglobal;
};

/**
 * Returns true if the frame location refers to the command entered by the user
 * through the command line.
 *
 * @param {string} frameLocation
 *
 * @return {boolean}
 */
// xxxHonza: should be renamed. It's not only related to the CommandLine, but
// to all bogus scripts, e.g. generated from 'clientEvaluate' packets.
DebuggerLib.isFrameLocationEval = function(frameFilename)
{
    return frameFilename === "debugger eval code" || frameFilename === "self-hosted";
}

// ********************************************************************************************* //
// Local Access (hack for easier transition to JSD2/RDP)

/**
 * The next step is to make this method asynchronous to be closer to the
 * remote debugging requirements. Of course, it should use Promise
 * as the return value.
 *
 * @param {Object} context
 * @param {Object} actorId
 */
DebuggerLib.getObject = function(context, actorId)
{
    try
    {
        // xxxHonza: access server side objects, of course even hacks needs
        // good architecure, refactor.
        // First option: implement a provider used by UI widgets (e.g. DomTree)
        // See: https://bugzilla.mozilla.org/show_bug.cgi?id=837723
        var threadActor = this.getThreadActor(context);
        var actor = threadActor.threadLifetimePool.get(actorId);

        if (!actor && threadActor._pausePool)
            actor = threadActor._pausePool.get(actorId);

        if (!actor)
            return null;

        return this.unwrapDebuggeeValue(actor.obj);
    }
    catch (e)
    {
        TraceError.sysout("debuggerClientModule.getObject; EXCEPTION " + e, e);
    }
}

DebuggerLib.getThreadActor = function(context)
{
    try
    {
        var conn = DebuggerServer._connections["conn0."];
        var tabActor = conn.rootActor._tabActors.get(context.browser);
        return tabActor.threadActor;
    }
    catch (e)
    {
        TraceError.sysout("debuggerClientModule.getObject; EXCEPTION " + e, e);
    }
}

// ********************************************************************************************* //
// Stack Frames

DebuggerLib.getCurrentFrames = function(context)
{
    var threadActor = this.getThreadActor(context);
    return onFrames.call(threadActor, {});
}

// xxxHonza: hack, the original method, returns a promise now.
// TODO: refactor
function onFrames(aRequest)
{
    if (this.state !== "paused")
    {
        return {
            error: "wrongState",
            message: "Stack frames are only available while the debuggee is paused."
        };
    }

    var start = aRequest.start ? aRequest.start : 0;
    var count = aRequest.count;

    // Find the starting frame...
    var frame = this._youngestFrame;
    var i = 0;
    while (frame && (i < start))
    {
        frame = frame.older;
        i++;
    }

    // Return request.count frames, or all remaining
    // frames if count is not defined.
    var frames = [];
    var promises = [];
    for (; frame && (!count || i < (start + count)); i++, frame=frame.older)
    {
        var form = this._createFrameActor(frame).form();
        form.depth = i;
        frames.push(form);
    }

    return frames;
}

// ********************************************************************************************* //
// Executable Lines

DebuggerLib.getNextExecutableLine = function(context, aLocation)
{
    var threadClient = this.getThreadActor(context);

    var scripts = threadClient.dbg.findScripts(aLocation);
    if (scripts.length == 0)
        return;

    for (var i=0; i<scripts.length; i++)
    {
        var script = scripts[i];
        var offsets = script.getLineOffsets(aLocation.line);
        if (offsets.length > 0)
            return aLocation;
    }

    var scripts = threadClient.dbg.findScripts({
        url: aLocation.url,
        line: aLocation.line,
        innermost: true
    });

    for (var i=0; i<scripts.length; i++)
    {
        var script = scripts[i];
        var offsets = script.getAllOffsets();
        for (var line = aLocation.line; line < offsets.length; ++line)
        {
            if (offsets[line])
            {
                return {
                    url: aLocation.url,
                    line: line,
                    column: aLocation.column
                };
            }
        }
    }
}

// ********************************************************************************************* //
// Debugger

DebuggerLib.breakNow = function(context)
{
    // getDebugeeGlobal uses the current global (ie. stopped frame, current iframe or
    // top level window associated with the context object).
    // There can be cases (e.g. BON XHR) where the current window is an iframe, but
    // the event the debugger breaks on - comes from top level window (or vice versa).
    // For now there are not known problems, but we might want to use the second
    // argument of the getDebuggeeGlobal() and pass explicit global object.
    var dGlobal = this.getDebuggeeGlobal(context);
    return dGlobal.evalInGlobal("debugger");
}

// ********************************************************************************************* //
// Local helpers

/**
 * Gets or creates the Inactive Debugger instance for the given context (singleton).
 *
 * @param context {*}
 *
 * @return {Debugger} The Debugger instance
 */
var getInactiveDebuggerForContext = function(context)
{
    var DebuggerClass;
    var scope = {};

    if (context.inactiveDebugger)
        return context.inactiveDebugger;

    try
    {
        Cu.import("resource://gre/modules/jsdebugger.jsm", scope);
        scope.addDebuggerToGlobal(window);
        DebuggerClass = window.Debugger;
    }
    catch (exc)
    {
        if (FBTrace.DBG_ERROR)
            FBTrace.sysout("DebuggerLib.getInactiveDebuggerForContext; Debugger not found", exc);
    }

    // If the Debugger Class was not found, make this function no-op.
    if (!DebuggerClass)
        getInactiveDebuggerForContext = function() {};

    var dbg = new DebuggerClass();
    dbg.enabled = false;
    context.inactiveDebugger = dbg;
    return dbg;
};

// ********************************************************************************************* //
// Registration

return DebuggerLib;

// ********************************************************************************************* //
});