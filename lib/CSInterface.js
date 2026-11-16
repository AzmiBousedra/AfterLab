/* Minimal CEP CSInterface wrapper: only evalScript is needed by AfterLab. */
(function (global) {
  function CSInterface() {}

  CSInterface.prototype.evalScript = function (script, callback) {
    if (!global.__adobe_cep__ || typeof global.__adobe_cep__.evalScript !== "function") {
      if (typeof callback === "function") {
        callback("EvalScript error.");
      }
      return;
    }

    global.__adobe_cep__.evalScript(script, callback);
  };

  global.CSInterface = CSInterface;
})(window);
